import type {
  BookingDataProvider,
  NotificationDataProvider,
  OpexAuditDeadLetter,
  OpexAuditPending,
  OpexBookingAudit,
  OpexBookingAuditV2,
  CanonicalAuditInput,
  ActorInfo,
  BookingAction,
  AuditReconciliationResult,
  ResolvedBooking,
  NormalizedAuditEvent,
} from "../data/types";
import type { AppMode } from "../auth/identityResolver";
import type { IdentityResolutionState } from "../auth/identityResolver";

/* The normalization layer (normalizeAuditRecord, isCanonicalAudit) lives in
   ../data/types.ts and is imported directly by UI-side modules. The standalone
   Service Add-In bundle inlines its own copy (see serviceAddin.ts) so that
   this module has no runtime value import from types.ts, keeping the
   standalone --module ESNext build valid without allowImportingTsExtensions. */

export type AuditAction = BookingAction;

export type AuditFieldSnapshot = {
  status?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  destination?: string | null;
  purpose?: string | null;
  assetId?: string | null;
  assetName?: string | null;
  driverId?: string | null;
  driverName?: string | null;
};

export type AuditEmitInput = {
  mode: AppMode;
  provider: BookingDataProvider & Partial<NotificationDataProvider>;
  entityId: string;
  action: AuditAction;
  actorUserId: string;
  /** Optional authenticated identity. If provided, actorUserId must match identity.principal.id. */
  identity?: IdentityResolutionState | null;
  previousStatus?: string | null;
  newStatus?: string | null;
  previous?: AuditFieldSnapshot | null;
  next?: AuditFieldSnapshot | null;
  metadata?: Record<string, unknown>;
  /** Key to suppress duplicate emits for the same logical action in-process */
  idempotencyKey?: string;
};

export type AuditEmitResult =
  | { ok: true; deduped?: boolean }
  | { ok: false; error: string; deduped?: boolean };

const recentKeys = new Set<string>();

export function resetAuditDedupForTests() {
  recentKeys.clear();
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ note: "unserializable_details" });
  }
}

export function snapshotBooking(b: ResolvedBooking | null | undefined): AuditFieldSnapshot | null {
  if (!b) return null;
  return {
    status: b.status ?? null,
    startAt: b.start_at ?? null,
    endAt: b.end_at ?? null,
    destination: b.destination ?? null,
    purpose: b.purpose ?? null,
    assetId: b.asset_id ?? null,
    assetName: b.asset_name ?? null,
    driverId: b.driver_id ?? null,
    driverName: b.driver_name ?? null,
  };
}

export function diffRelevantFields(previous: AuditFieldSnapshot | null | undefined, next: AuditFieldSnapshot | null | undefined) {
  const keys: (keyof AuditFieldSnapshot)[] = ["status", "startAt", "endAt", "destination", "purpose", "assetId", "driverId"];
  const changed: Record<string, { previous: unknown; next: unknown }> = {};
  for (const k of keys) {
    const p = previous?.[k] ?? null;
    const n = next?.[k] ?? null;
    if (p !== n) changed[k] = { previous: p, next: n };
  }
  return changed;
}

/*───────────────────── Audit pending queue (retry/recovery) ─────────────────────*/

export type AuditPendingState = "pending" | "recovering" | "idle";

export interface AuditRecoveryStats {
  pendingCount: number;
  recoveredCount: number;
  failedCount: number;
  state: AuditPendingState;
}

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

let pendingQueue: OpexAuditPending[] = [];
let queueState: AuditPendingState = "idle";
let recoveryInProgress = false;

/* Cumulative recovery statistics for observability. */
let totalRecovered = 0;
let totalFailed = 0;
let lastRecoveryError: string | null = null;

/* Build the full audit event payload that was attempted, so it can be
   reconstructed into an OpexBookingAudit record on retry. */
function buildAuditRecordInput(
  input: AuditEmitInput,
  actorUserId: string,
): Omit<OpexBookingAudit, "recordType" | "schemaVersion" | "id" | "created_at"> {
  return {
    booking_id: input.entityId,
    action: input.action,
    actor_user_id: actorUserId,
    previous_status: input.previousStatus ?? input.previous?.status ?? null,
    new_status: input.newStatus ?? input.next?.status ?? null,
    details: input.metadata ? safeJson(input.metadata) : null,
  };
}

function backoffMs(retryCount: number): number {
  return Math.min(INITIAL_BACKOFF_MS * 2 ** retryCount, MAX_BACKOFF_MS);
}

function nextRetryAt(retryCount: number): string | null {
  return new Date(Date.now() + backoffMs(retryCount)).toISOString();
}

/* Store a failed audit write as a pending record for later recovery. */
async function queueAuditPending(
  provider: NotificationDataProvider,
  input: AuditEmitInput,
  actorUserId: string,
  error: string,
): Promise<void> {
  try {
    const existing = pendingQueue.find(p =>
      p.booking_id === input.entityId &&
      p.action === input.action &&
      p.actor_user_id === actorUserId &&
      p.retry_count < p.max_retries,
    );
    if (existing) {
      existing.retry_count += 1;
      existing.last_error = error;
      existing.next_retry_at = nextRetryAt(existing.retry_count);
      await provider.createAuditPending({
        booking_id: existing.booking_id,
        action: existing.action,
        actor_user_id: existing.actor_user_id,
        previous_status: existing.previous_status,
        new_status: existing.new_status,
        details: existing.details,
      });
      await provider.deleteAuditPending(existing.id);
      const idx = pendingQueue.findIndex(p => p.id === existing.id);
      if (idx >= 0) pendingQueue[idx] = { ...existing };
      return;
    }
    const recordInput = buildAuditRecordInput(input, actorUserId);
    await provider.createAuditPending({
      booking_id: recordInput.booking_id,
      action: recordInput.action,
      actor_user_id: recordInput.actor_user_id,
      previous_status: recordInput.previous_status,
      new_status: recordInput.new_status,
      details: recordInput.details,
    });
  } catch {
    /* Best-effort queue; if we can't even queue, the audit event is lost. */
  }
}

/* Load all pending audit records from the provider into the in-memory queue. */
async function loadPendingQueue(provider: NotificationDataProvider): Promise<void> {
  try {
    pendingQueue = await provider.getAuditPending();
  } catch {
    pendingQueue = [];
  }
}

/* Retry all pending audit records that are due. Returns recovery stats. */
export async function recoverAuditPending(
  provider: NotificationDataProvider,
): Promise<AuditRecoveryStats> {
  if (recoveryInProgress) {
    return { pendingCount: pendingQueue.length, recoveredCount: 0, failedCount: 0, state: queueState };
  }
  recoveryInProgress = true;
  queueState = "recovering";

  await loadPendingQueue(provider);

  const now = new Date();
  const due = pendingQueue.filter(p => {
    if (!p.next_retry_at) return true;
    return new Date(p.next_retry_at) <= now;
  });

  let recovered = 0;
  let failed = 0;

  for (const pending of due) {
    const createAuditRecord = provider.createAuditRecord;
    if (typeof createAuditRecord !== "function") {
      failed += 1;
      totalFailed += 1;
      lastRecoveryError = "AUDIT_PROVIDER_UNAVAILABLE";
      continue;
    }
    try {
      /* Skip recovery if a canonical audit already exists for this
         booking+action+actor. This prevents duplicate audit records when the
         original write succeeded but the response was lost (crash window).
         Canonical audits are written by emitAuditEvent after Worker booking
         confirmation; legacy pending audits are only a fallback. */
      const existingAudits = await provider.getAuditRecords?.(pending.booking_id);
      const alreadyAudited = existingAudits?.some(
        a => a.sourceFormat === "canonical"
          && a.action === pending.action
          && a.actor.userId === pending.actor_user_id,
      );
      if (alreadyAudited) {
        await provider.deleteAuditPending(pending.id);
        pendingQueue = pendingQueue.filter(p => p.id !== pending.id);
        recovered += 1;
        totalRecovered += 1;
        continue;
      }

      await createAuditRecord.call(provider, {
        booking_id: pending.booking_id,
        action: pending.action,
        actor_user_id: pending.actor_user_id,
        previous_status: pending.previous_status,
        new_status: pending.new_status,
        details: pending.details,
      });
      await provider.deleteAuditPending(pending.id);
      pendingQueue = pendingQueue.filter(p => p.id !== pending.id);
      recovered += 1;
      totalRecovered += 1;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "AUDIT_WRITE_FAILED";
      pending.retry_count += 1;
      pending.last_error = errorMsg;
      lastRecoveryError = errorMsg;
      if (pending.retry_count >= (pending.max_retries ?? MAX_RETRIES)) {
        /* Move to dead-letter state instead of deleting — preserves original
           event, error, and retry metadata for later inspection.

           Processing order:
           1. Create dead-letter record first.
           2. Only after successful creation, delete the pending record.
           3. If creation fails, retain the pending record for later retry.
           This ensures no audit event is silently lost. */
        const notifProvider = provider as NotificationDataProvider;
        let deadLetterCreated = false;
        try {
          await notifProvider.createAuditDeadLetter?.({
            booking_id: pending.booking_id,
            action: pending.action,
            actor_user_id: pending.actor_user_id,
            previous_status: pending.previous_status,
            new_status: pending.new_status,
            details: pending.details,
            retry_count: pending.retry_count,
            max_retries: pending.max_retries,
            last_error: pending.last_error,
            next_retry_at: pending.next_retry_at,
            original_pending_id: pending.id,
          });
          deadLetterCreated = true;
        } catch {
          /* Dead-letter creation failed — retain pending record for retry. */
          lastRecoveryError = "DEAD_LETTER_CREATION_FAILED";
        }

        if (deadLetterCreated) {
          await provider.deleteAuditPending(pending.id);
          pendingQueue = pendingQueue.filter(p => p.id !== pending.id);
          failed += 1;
          totalFailed += 1;
        }
        /* If dead-letter creation failed, the pending record stays in the
           queue and will be retried on the next recovery cycle. */
      } else {
        pending.next_retry_at = nextRetryAt(pending.retry_count);
        try {
          const existingIdx = pendingQueue.findIndex(p => p.id === pending.id);
          if (existingIdx >= 0) pendingQueue[existingIdx] = { ...pending };
          await provider.createAuditPending({
            booking_id: pending.booking_id,
            action: pending.action,
            actor_user_id: pending.actor_user_id,
            previous_status: pending.previous_status,
            new_status: pending.new_status,
            details: pending.details,
          });
          await provider.deleteAuditPending(pending.id);
        } catch {
          /* best-effort update */
        }
        failed += 1;
        totalFailed += 1;
      }
    }
  }

  queueState = pendingQueue.length > 0 ? "pending" : "idle";
  recoveryInProgress = false;

  return {
    pendingCount: pendingQueue.length,
    recoveredCount: recovered,
    failedCount: failed,
    state: queueState,
  };
}

export function getAuditQueueState(): AuditRecoveryStats {
  return {
    pendingCount: pendingQueue.length,
    recoveredCount: totalRecovered,
    failedCount: totalFailed,
    state: queueState,
  };
}

export function resetAuditQueueForTests() {
  pendingQueue = [];
  queueState = "idle";
  recoveryInProgress = false;
  recentKeys.clear();
}

/* Compute only the fields that actually changed between previous and next
   snapshots, mirroring auditEvent.computeChanges but kept local so this
   module has no runtime value imports (it is dynamically imported by the
   standalone Service Add-In build). */
function auditFieldChanges(previous: Record<string, unknown> | null | undefined, next: Record<string, unknown> | null | undefined): Record<string, { from: unknown; to: unknown }> {
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  const keys: string[] = ["status", "startAt", "endAt", "destination", "purpose", "assetId", "driverId"];
  for (const k of keys) {
    const p = previous?.[k] ?? null;
    const n = next?.[k] ?? null;
    if (p !== n) {
      changed[k] = { from: p, to: n };
    }
  }
  return changed;
}

/*───────────────────── Audit event emission (with retry queue) ─────────────────────*/

export async function emitAuditEvent(input: AuditEmitInput): Promise<AuditEmitResult> {
  const { mode, provider, entityId, action, actorUserId, identity, previousStatus, newStatus, previous, next, metadata, idempotencyKey } = input;
  if (!entityId || !action) {
    return { ok: false, error: "AUDIT_INVALID_INPUT" };
  }
  /* Derive actor identity from the verified MyGeotab principal (server-side).
     Never trust browser-provided userId/userName/role. Fail closed for
     protected LIVE operations when the actor cannot be verified. */
  let actor: ActorInfo;
  if (identity && identity.status === "authenticated") {
    /* Derive actor identity from the verified MyGeotab principal. A
       caller-supplied actorUserId is never allowed to override the verified
       principal; it is ignored for LIVE authenticated operations. */
    actor = {
      userId: identity.principal.id,
      ...(identity.principal.name ? { userName: identity.principal.name } : {}),
      ...(identity.principal.roles?.[0] ? { role: identity.principal.roles[0] } : {}),
    };
  } else if (mode === "DEMO") {
    actor = actorUserId ? { userId: actorUserId } : { userId: "demo-actor" };
  } else {
    return { ok: false, error: "AUDIT_ACTOR_UNVERIFIED" };
  }
  const createBookingAuditEvent = provider.createBookingAuditEvent;
  if (typeof createBookingAuditEvent !== "function") {
    return { ok: false, error: "AUDIT_PROVIDER_UNAVAILABLE" };
  }

  const idem = idempotencyKey ?? `${mode}:${entityId}:${action}:${previousStatus ?? ""}:${newStatus ?? ""}:${actor.userId}:${safeJson(metadata ?? null)}`;
  if (recentKeys.has(idem)) {
    return { ok: true, deduped: true };
  }

  /* Cross-session dedup: check if a canonical audit record with this auditKey
     already exists in AddInData. Survives page reloads (unlike recentKeys).
     AddInData has no atomic compare-and-set, so this is best-effort — two
     concurrent requests could both read "none exists" and both write. That
     race is unavoidable with the current platform; reconciliation detects
     duplicates via DUPLICATE_AUDIT_EVENT findings. */
  try {
    const existingAudits = await provider.getAuditRecords?.(entityId);
    const alreadyExists = existingAudits?.some(
      (a) => a.sourceFormat === "canonical" && a.auditKey === idem,
    );
    if (alreadyExists) {
      recentKeys.add(idem);
      return { ok: true, deduped: true };
    }
  } catch {
    /* Dedup check failed — proceed with the write rather than blocking a
       legitimate audit event. The pending-audit queue handles write failures. */
  }

  const changes = auditFieldChanges(previous, next);
  const canonicalInput: CanonicalAuditInput = {
    auditKey: idem,
    bookingKey: entityId,
    action: action as BookingAction,
    actor,
    occurredAtUtc: new Date().toISOString(),
    previousStatus: previousStatus ?? null,
    newStatus: newStatus ?? null,
    changes,
    metadata: {
      ...(metadata && typeof metadata === "object" ? metadata : {}),
      source: typeof metadata?.source === "string" ? metadata.source : "ui.auditTrail",
      mode,
    },
  };

  try {
    await createBookingAuditEvent.call(provider, canonicalInput);
    recentKeys.add(idem);

    /* Attempt to recover any previously pending audit records after a successful write. */
    const notifProvider = provider as NotificationDataProvider;
    void recoverAuditPending(notifProvider);

    return { ok: true };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : "AUDIT_WRITE_FAILED";
    const notifProvider = provider as NotificationDataProvider;
    await queueAuditPending(notifProvider, input, actor.userId, errorMsg);
    return { ok: false, error: errorMsg };
  }
}

/*───────────────────── Audit reconciliation ─────────────────────*/

/* Compare bookings against audit records to find bookings missing expected
   audit events. This detects bookings that were modified directly (bypassing
   the audit trail) or where audit writes failed and were not recovered. */
export function reconcileAudit(
  bookings: ResolvedBooking[],
  audits: OpexBookingAudit[],
): AuditReconciliationResult[] {
  /* Build a map of booking_id -> latest audit action for that booking */
  const auditByBooking = new Map<string, { action: string; timestamp: string }[]>();
  for (const audit of audits) {
    const existing = auditByBooking.get(audit.booking_id) ?? [];
    existing.push({ action: audit.action, timestamp: audit.created_at });
    auditByBooking.set(audit.booking_id, existing);
  }

  const results: AuditReconciliationResult[] = [];

  for (const booking of bookings) {
    const auditsForBooking = auditByBooking.get(booking.id) ?? [];
    const lastAudit = auditsForBooking.length > 0
      ? auditsForBooking.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0]
      : null;

    /* Determine expected audit actions for the booking's current status */
    const expectedActions = expectedAuditActionsForStatus(booking.status);
    const missingActions = expectedActions.filter(
      expected => !auditsForBooking.some(a => a.action === expected),
    );

    if (missingActions.length > 0) {
      results.push({
        booking_id: booking.id,
        booking_status: booking.status,
        missing_audit_actions: missingActions,
        last_audit_action: lastAudit?.action ?? null,
        last_audit_timestamp: lastAudit?.timestamp ?? null,
      });
    }
  }

  return results;
}

/* Expected audit actions for a given booking status. */
function expectedAuditActionsForStatus(status: string): string[] {
  switch (status) {
    case "PENDING_APPROVAL":
      return ["BOOKING_CREATED"];
    case "APPROVED":
      return ["BOOKING_CREATED", "BOOKING_APPROVED"];
    case "REJECTED":
      return ["BOOKING_CREATED", "BOOKING_REJECTED"];
    case "ASSIGNED":
      return ["BOOKING_CREATED", "BOOKING_APPROVED", "VEHICLE_ASSIGNED"];
    case "COMPLETED":
      return ["BOOKING_CREATED", "BOOKING_APPROVED", "VEHICLE_ASSIGNED", "BOOKING_COMPLETED"];
    case "CANCELLED":
      return ["BOOKING_CREATED", "BOOKING_CANCELLED"];
    case "DRAFT":
    case "SUBMITTED":
      return ["BOOKING_CREATED"];
    default:
      return [];
  }
}

/*───────────────────── Enhanced Audit Reconciliation Engine ─────────────────────*/
/* Comprehensive reconciliation that scans booking records against audit
   records to detect security-relevant anomalies. Original audit evidence
   is never overwritten; findings are stored as separate reconciliation
   finding records for administrator review. */

import type { OpexReconciliationFinding, ReconciliationFindingType, ReconciliationSeverity, ReconciliationStatus } from "../data/types";

/* Generate a deterministic finding ID from booking ID, finding type, and
   detection timestamp. Not cryptographically secure — used for dedup. */
function generateFindingId(bookingId: string, findingType: ReconciliationFindingType, timestamp: string): string {
  const raw = `${bookingId}:${findingType}:${timestamp}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `find-${Math.abs(hash).toString(16)}-${bookingId.slice(-8)}`;
}

/* Classify evidence into one of four categories. Does not assume malicious
   intent — missing audit records may result from interrupted operations. */
export function classifyEvidence(
  findingType: ReconciliationFindingType,
  hasValidActor: boolean,
  hasValidTransition: boolean,
  hasPriorAuditTrail: boolean,
): "LEGITIMATE_PARTIAL_WRITE" | "INTERRUPTED_OPERATION" | "POTENTIAL_UNAUTHORIZED_WRITE" | "INSUFFICIENT_EVIDENCE" {
  /* If we cannot determine the cause, default to insufficient evidence. */
  if (!hasValidActor && !hasValidTransition && !hasPriorAuditTrail) {
    return "INSUFFICIENT_EVIDENCE";
  }
  /* Legitimate partial write: booking created but audit write interrupted */
  if (findingType === "MISSING_AUDIT_EVENT" && hasValidActor && hasValidTransition && hasPriorAuditTrail) {
    return "LEGITIMATE_PARTIAL_WRITE";
  }
  /* Interrupted operation: actor and transition are valid, no prior trail */
  if (findingType === "MISSING_AUDIT_EVENT" && hasValidActor && hasValidTransition && !hasPriorAuditTrail) {
    return "INTERRUPTED_OPERATION";
  }
  /* Potential unauthorized write: invalid actor or invalid transition */
  if (!hasValidActor || !hasValidTransition) {
    return "POTENTIAL_UNAUTHORIZED_WRITE";
  }
  return "INSUFFICIENT_EVIDENCE";
}

/* Determine severity for a finding type. */
export function findingSeverity(findingType: ReconciliationFindingType): ReconciliationSeverity {
  switch (findingType) {
    case "INVALID_ACTOR_ATTRIBUTION":
    case "RECORD_MODIFIED_WITHOUT_AUDIT":
    case "DUPLICATE_BOOKING_RECORD":
    case "DUPLICATE_AUDIT_EVENT":
      return "HIGH";
    case "UNEXPECTED_STATUS_TRANSITION":
    case "RECORD_DELETED_WITHOUT_AUDIT":
    case "NOTIFICATION_MANIPULATION":
      return "HIGH";
    case "MISSING_AUDIT_EVENT":
      return "MEDIUM";
    case "VERSION_MISMATCH":
    case "INCONSISTENT_BOOKING_STATE":
      return "MEDIUM";
    case "INSUFFICIENT_EVIDENCE":
      return "LOW";
    default:
      return "MEDIUM";
  }
}

/* Expected audit actions for a given booking status (shared with existing logic). */
function expectedAuditActionsForStatusEnhanced(status: string): string[] {
  switch (status) {
    case "PENDING_APPROVAL":
      return ["BOOKING_CREATED"];
    case "APPROVED":
      return ["BOOKING_CREATED", "BOOKING_APPROVED"];
    case "REJECTED":
      return ["BOOKING_CREATED", "BOOKING_REJECTED"];
    case "ASSIGNED":
      return ["BOOKING_CREATED", "BOOKING_APPROVED", "VEHICLE_ASSIGNED"];
    case "IN_PROGRESS":
      return ["BOOKING_CREATED", "BOOKING_APPROVED", "VEHICLE_ASSIGNED", "DRIVER_ASSIGNED"];
    case "COMPLETED":
      return ["BOOKING_CREATED", "BOOKING_APPROVED", "VEHICLE_ASSIGNED", "DRIVER_ASSIGNED", "BOOKING_COMPLETED"];
    case "CANCELLED":
      return ["BOOKING_CREATED", "BOOKING_CANCELLED"];
    case "DRAFT":
    case "SUBMITTED":
      return ["BOOKING_CREATED"];
    default:
      return [];
  }
}

/* Valid booking state transitions (mirrors authz.ts validateTransition). */
const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["PENDING_APPROVAL"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["IN_PROGRESS", "COMPLETED", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
};

/* Enhanced reconciliation result with full finding details. */
export interface EnhancedReconciliationFinding {
  finding_id: string;
  booking_id: string;
  finding_type: ReconciliationFindingType;
  severity: ReconciliationSeverity;
  expected_state: string | null;
  observed_state: string | null;
  detection_timestamp: string;
  related_audit_references: string[];
  reconciliation_status: ReconciliationStatus;
  evidence_classification: "LEGITIMATE_PARTIAL_WRITE" | "INTERRUPTED_OPERATION" | "POTENTIAL_UNAUTHORIZED_WRITE" | "INSUFFICIENT_EVIDENCE";
  notes: string | null;
}

/* Comprehensive reconciliation of bookings against audit records, notifications,
   and version history. Returns structured findings for each anomaly detected. */
export function reconcileAuditEnhanced(
  bookings: ResolvedBooking[],
  audits: NormalizedAuditEvent[],
  notifications: { id: string; booking_id: string; actor_user_id: string; created_at: string; type: string }[],
): EnhancedReconciliationFinding[] {
  const findings: EnhancedReconciliationFinding[] = [];
  const now = new Date().toISOString();

  /* Build audit lookup by booking key. Both legacy ("booking_audit") and
     canonical ("bookingAudit") records are normalized into a common shape
     before reaching this function, so a single lookup works for both. */
  const auditByBooking = new Map<string, NormalizedAuditEvent[]>();
  for (const audit of audits) {
    if (!audit || typeof audit !== "object") continue;
    const bk = audit.bookingKey;
    if (typeof bk !== "string") continue;
    const existing = auditByBooking.get(bk) ?? [];
    existing.push(audit);
    auditByBooking.set(bk, existing);
  }

  /* Build notification lookup by booking ID */
  const notificationByBooking = new Map<string, typeof notifications[number][]>();
  for (const n of notifications) {
    const existing = notificationByBooking.get(n.booking_id) ?? [];
    existing.push(n);
    notificationByBooking.set(n.booking_id, existing);
  }

  /* Track booking IDs seen to detect duplicates */
  const bookingIdCounts = new Map<string, number>();
  for (const b of bookings) {
    bookingIdCounts.set(b.id, (bookingIdCounts.get(b.id) ?? 0) + 1);
  }

  for (const booking of bookings) {
    const auditsForBooking = auditByBooking.get(booking.id) ?? [];
    const notificationsForBooking = notificationByBooking.get(booking.id) ?? [];

    /* Sort audits by timestamp descending */
    const sortedAudits = [...auditsForBooking].sort((a, b) => {
      const ta = a.occurredAtUtc ? new Date(a.occurredAtUtc).getTime() : 0;
      const tb = b.occurredAtUtc ? new Date(b.occurredAtUtc).getTime() : 0;
      return tb - ta;
    });
    const lastAudit = sortedAudits.length > 0 ? sortedAudits[0] : null;

    /* 1. Missing audit events */
    const expectedActions = expectedAuditActionsForStatusEnhanced(booking.status);
    const missingActions = expectedActions.filter(
      expected => !auditsForBooking.some(a => a.action === expected),
    );
    if (missingActions.length > 0) {
      const hasValidActor = lastAudit ? lastAudit.actor.userId === booking.requester_id : false;
      const classification = classifyEvidence(
        "MISSING_AUDIT_EVENT",
        hasValidActor,
        true,
        auditsForBooking.length > 0,
      );
      findings.push({
        finding_id: generateFindingId(booking.id, "MISSING_AUDIT_EVENT", now),
        booking_id: booking.id,
        finding_type: "MISSING_AUDIT_EVENT",
        severity: findingSeverity("MISSING_AUDIT_EVENT"),
        expected_state: `Expected audit actions: ${expectedActions.join(", ")}`,
        observed_state: `Present audit actions: ${auditsForBooking.map(a => a.action).join(", ") || "none"}`,
        detection_timestamp: now,
        related_audit_references: auditsForBooking.map(a => a.id),
        reconciliation_status: "OPEN",
        evidence_classification: classification,
        notes: `Booking ${booking.id} in status ${booking.status} is missing audit events: ${missingActions.join(", ")}`,
      });
    }

    /* 2. Unexpected status transitions (audit shows a transition not in valid list) */
    for (let i = 1; i < sortedAudits.length; i++) {
      const prev = sortedAudits[i - 1];
      const curr = sortedAudits[i];
      const prevStatus = prev.newStatus ?? prev.previousStatus;
      const currStatus = curr.newStatus ?? curr.previousStatus;
      if (prevStatus && currStatus) {
        const allowed = VALID_TRANSITIONS[prevStatus];
        if (allowed && !allowed.includes(currStatus)) {
          findings.push({
            finding_id: generateFindingId(booking.id, "UNEXPECTED_STATUS_TRANSITION", `${now}:${i}`),
            booking_id: booking.id,
            finding_type: "UNEXPECTED_STATUS_TRANSITION",
            severity: findingSeverity("UNEXPECTED_STATUS_TRANSITION"),
            expected_state: `Valid transitions from ${prevStatus}: ${allowed.join(", ")}`,
            observed_state: `Transition ${prevStatus} -> ${currStatus} at ${curr.occurredAtUtc}`,
            detection_timestamp: now,
            related_audit_references: [prev.id, curr.id],
            reconciliation_status: "OPEN",
            evidence_classification: classifyEvidence(
              "UNEXPECTED_STATUS_TRANSITION",
              curr.actor.userId === booking.requester_id,
              false,
              true,
            ),
            notes: `Audit record ${curr.id} shows unexpected transition ${prevStatus} -> ${currStatus}`,
          });
        }
      }
    }

    /* 3. Invalid actor attribution (audit actor doesn't match booking requester) */
    for (const audit of sortedAudits) {
      if (audit.actor.userId && audit.actor.userId !== booking.requester_id) {
        /* Allow approver to act on behalf of requester for approval actions */
        const isApprovalAction = audit.action === "BOOKING_APPROVED" || audit.action === "BOOKING_REJECTED";
        const isDriverAssignment = audit.action === "VEHICLE_ASSIGNED" || audit.action === "DRIVER_ASSIGNED";
        if (!isApprovalAction && !isDriverAssignment) {
          findings.push({
            finding_id: generateFindingId(booking.id, "INVALID_ACTOR_ATTRIBUTION", `${now}:${audit.id}`),
            booking_id: booking.id,
            finding_type: "INVALID_ACTOR_ATTRIBUTION",
            severity: findingSeverity("INVALID_ACTOR_ATTRIBUTION"),
            expected_state: `Actor should be ${booking.requester_id} (booking requester)`,
            observed_state: `Actor recorded as ${audit.actor.userId} in audit ${audit.id}`,
            detection_timestamp: now,
            related_audit_references: [audit.id],
            reconciliation_status: "OPEN",
            evidence_classification: classifyEvidence(
              "INVALID_ACTOR_ATTRIBUTION",
              false,
              true,
              true,
            ),
            notes: `Audit record ${audit.id} has actor ${audit.actor.userId} that does not match booking requester ${booking.requester_id}`,
          });
        }
      }
    }

    /* 4. Version mismatch (booking version inconsistent with audit count) */
    const auditCountForBooking = auditsForBooking.length;
    if (booking.version > 0 && auditCountForBooking > 0 && booking.version !== auditCountForBooking + 1) {
      /* version starts at 1, each audit represents a state change; initial creation has 1 audit */
      findings.push({
        finding_id: generateFindingId(booking.id, "VERSION_MISMATCH", now),
        booking_id: booking.id,
        finding_type: "VERSION_MISMATCH",
        severity: findingSeverity("VERSION_MISMATCH"),
        expected_state: `Booking version ${booking.version} should align with ${auditCountForBooking + 1} audit records`,
        observed_state: `Booking version ${booking.version} with ${auditCountForBooking} audit records`,
        detection_timestamp: now,
        related_audit_references: auditsForBooking.map(a => a.id),
        reconciliation_status: "OPEN",
        evidence_classification: classifyEvidence(
          "VERSION_MISMATCH",
          true,
          true,
          true,
        ),
        notes: `Booking ${booking.id} version ${booking.version} inconsistent with ${auditCountForBooking} audit records`,
      });
    }

    /* 5. Duplicate booking records */
    const count = bookingIdCounts.get(booking.id) ?? 0;
    if (count > 1) {
      findings.push({
        finding_id: generateFindingId(booking.id, "DUPLICATE_BOOKING_RECORD", now),
        booking_id: booking.id,
        finding_type: "DUPLICATE_BOOKING_RECORD",
        severity: findingSeverity("DUPLICATE_BOOKING_RECORD"),
        expected_state: `Single booking record for ID ${booking.id}`,
        observed_state: `${bookingIdCounts.get(booking.id)} booking records with ID ${booking.id}`,
        detection_timestamp: now,
        related_audit_references: auditsForBooking.map(a => a.id),
        reconciliation_status: "OPEN",
        evidence_classification: classifyEvidence(
          "DUPLICATE_BOOKING_RECORD",
          true,
          true,
          true,
        ),
        notes: `Duplicate booking records detected for ID ${booking.id}`,
      });
    }

    /* 6. Inconsistent booking state (status without expected audit trail) */
    if (booking.status === "APPROVED" && !auditsForBooking.some(a => a.action === "BOOKING_APPROVED")) {
      findings.push({
        finding_id: generateFindingId(booking.id, "INCONSISTENT_BOOKING_STATE", now),
        booking_id: booking.id,
        finding_type: "INCONSISTENT_BOOKING_STATE",
        severity: findingSeverity("INCONSISTENT_BOOKING_STATE"),
        expected_state: "APPROVED status requires BOOKING_APPROVED audit event",
        observed_state: "APPROVED status with no BOOKING_APPROVED audit event",
        detection_timestamp: now,
        related_audit_references: auditsForBooking.map(a => a.id),
        reconciliation_status: "OPEN",
        evidence_classification: classifyEvidence(
          "INCONSISTENT_BOOKING_STATE",
          true,
          true,
          auditsForBooking.length > 0,
        ),
        notes: `Booking ${booking.id} is APPROVED but lacks BOOKING_APPROVED audit event`,
      });
    }
  }

  /* 7. Detect bookings with audit records but no corresponding booking (orphaned audits) */
  const bookingIds = new Set(bookings.map(b => b.id));
  for (const audit of audits) {
    if (!audit || typeof audit !== "object") continue;
    const bk = audit.bookingKey ?? "";
    if (!bookingIds.has(bk)) {
      findings.push({
        finding_id: generateFindingId(bk, "RECORD_DELETED_WITHOUT_AUDIT", `${now}:${audit.id}`),
        booking_id: bk,
        finding_type: "RECORD_DELETED_WITHOUT_AUDIT",
        severity: findingSeverity("RECORD_DELETED_WITHOUT_AUDIT"),
        expected_state: "Booking record should exist for audit record",
        observed_state: `Audit record ${audit.id} exists for booking ${audit.bookingKey} but no booking record found`,
        detection_timestamp: now,
        related_audit_references: [audit.id],
        reconciliation_status: "OPEN",
        evidence_classification: classifyEvidence(
          "RECORD_DELETED_WITHOUT_AUDIT",
          false,
          false,
          true,
        ),
        notes: `Orphaned audit record ${audit.id} references deleted or missing booking ${audit.bookingKey} but no booking record found`,
      });
    }
  }

  /* 7b. Detect duplicate canonical audit events (same auditKey emitted more
     than once). Duplicate audit keys indicate a repeated logical write and
     are flagged for review — they are not deleted or overwritten. */
  const auditKeyCounts = new Map<string, NormalizedAuditEvent[]>();
  for (const audit of audits) {
    if (!audit || typeof audit !== "object") continue;
    if (audit.sourceFormat === "canonical" && audit.auditKey) {
      const existing = auditKeyCounts.get(audit.auditKey) ?? [];
      existing.push(audit);
      auditKeyCounts.set(audit.auditKey, existing);
    }
  }
  for (const [auditKey, duplicates] of auditKeyCounts) {
    if (duplicates.length > 1) {
      const bookingId = duplicates[0].bookingKey ?? "";
      findings.push({
        finding_id: generateFindingId(bookingId, "DUPLICATE_AUDIT_EVENT", `${now}:${auditKey}`),
        booking_id: bookingId,
        finding_type: "DUPLICATE_AUDIT_EVENT",
        severity: findingSeverity("DUPLICATE_AUDIT_EVENT"),
        expected_state: "Single audit event per auditKey",
        observed_state: `${duplicates.length} audit records share auditKey ${auditKey}`,
        detection_timestamp: now,
        related_audit_references: duplicates.map(d => d.id),
        reconciliation_status: "OPEN",
        evidence_classification: classifyEvidence(
          "DUPLICATE_AUDIT_EVENT",
          true,
          true,
          true,
        ),
        notes: `Duplicate canonical audit event auditKey ${auditKey} has ${duplicates.length} records`,
      });
    }
  }

  /* 8. Detect notification manipulation (notifications without booking context) */
  for (const n of notifications) {
    if (!bookingIds.has(n.booking_id)) {
      findings.push({
        finding_id: generateFindingId(n.booking_id, "NOTIFICATION_MANIPULATION", `${now}:${n.id}`),
        booking_id: n.booking_id,
        finding_type: "NOTIFICATION_MANIPULATION",
        severity: findingSeverity("NOTIFICATION_MANIPULATION"),
        expected_state: "Notification should reference an existing booking",
        observed_state: `Notification ${n.id} references non-existent booking ${n.booking_id}`,
        detection_timestamp: now,
        related_audit_references: [],
        reconciliation_status: "OPEN",
        evidence_classification: classifyEvidence(
          "NOTIFICATION_MANIPULATION",
          false,
          false,
          false,
        ),
        notes: `Notification ${n.id} references booking ${n.booking_id} that does not exist`,
      });
    }
  }

  return findings;
}

/* Store a reconciliation finding as an AddInData record. Does not modify
   original audit evidence — findings are separate records. */
export async function storeReconciliationFinding(
  provider: { createAuditRecord?: unknown } & Record<string, unknown>,
  finding: OpexReconciliationFinding,
): Promise<void> {
  /* Best-effort store; reconciliation findings are advisory only. */
  try {
    const createFn = (provider as { createReconciliationFinding?: (f: OpexReconciliationFinding) => Promise<void> }).createReconciliationFinding;
    if (typeof createFn === "function") {
      await createFn(finding);
    }
  } catch {
    /* Findings are advisory — failure to store is not critical */
  }
}

/* Convert an EnhancedReconciliationFinding to an OpexReconciliationFinding
   for storage in AddInData. */
export function toOpexReconciliationFinding(
  finding: EnhancedReconciliationFinding,
): OpexReconciliationFinding {
  return {
    recordType: "reconciliation_finding",
    schemaVersion: 1,
    id: finding.finding_id,
    finding_id: finding.finding_id,
    booking_id: finding.booking_id,
    finding_type: finding.finding_type,
    severity: finding.severity,
    expected_state: finding.expected_state,
    observed_state: finding.observed_state,
    detection_timestamp: finding.detection_timestamp,
    related_audit_references: finding.related_audit_references,
    reconciliation_status: finding.reconciliation_status,
    evidence_classification: finding.evidence_classification,
    notes: finding.notes,
  };
}
