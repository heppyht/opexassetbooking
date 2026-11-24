import type { BookingDataProvider, NotificationDataProvider, OpexAuditDeadLetter, OpexAuditPending, OpexBookingAudit, AuditReconciliationResult, ResolvedBooking } from "../data/types";
import type { AppMode } from "../auth/identityResolver";
import type { IdentityResolutionState } from "../auth/identityResolver";

export type AuditAction =
  | "BOOKING_CREATED"
  | "BOOKING_UPDATED"
  | "BOOKING_APPROVED"
  | "BOOKING_REJECTED"
  | "VEHICLE_ASSIGNED"
  | "DRIVER_ASSIGNED"
  | "BOOKING_COMPLETED"
  | "BOOKING_CANCELLED";

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

/*───────────────────── Audit event emission (with retry queue) ─────────────────────*/

export async function emitAuditEvent(input: AuditEmitInput): Promise<AuditEmitResult> {
  const { mode, provider, entityId, action, actorUserId, identity } = input;
  if (!entityId || !action || !actorUserId) {
    return { ok: false, error: "AUDIT_INVALID_INPUT" };
  }
  /* Validate actor identity against the authenticated principal.
     A caller cannot audit an action on behalf of another user. */
  if (identity && identity.status === "authenticated") {
    if (actorUserId.trim() !== identity.principal.id.trim()) {
      return { ok: false, error: "AUDIT_ACTOR_MISMATCH" };
    }
  }
  const createAuditRecord = provider.createAuditRecord;
  if (typeof createAuditRecord !== "function") {
    return { ok: false, error: "AUDIT_PROVIDER_UNAVAILABLE" };
  }

  const idem = input.idempotencyKey || `${mode}:${entityId}:${action}:${input.previousStatus ?? ""}:${input.newStatus ?? ""}:${actorUserId}:${safeJson(input.metadata ?? null)}`;
  if (recentKeys.has(idem)) {
    return { ok: true, deduped: true };
  }

  const details = safeJson({
    entityType: "BOOKING",
    entityId,
    mode,
    previous: input.previous ?? null,
    new: input.next ?? null,
    changed: diffRelevantFields(input.previous, input.next),
    metadata: input.metadata ?? null,
    idempotencyKey: idem,
  });

  try {
    await createAuditRecord.call(provider, {
      booking_id: entityId,
      action,
      actor_user_id: actorUserId,
      previous_status: input.previousStatus ?? input.previous?.status ?? null,
      new_status: input.newStatus ?? input.next?.status ?? null,
      details,
    });
    recentKeys.add(idem);

    /* Attempt to recover any previously pending audit records after a successful write. */
    const notifProvider = provider as NotificationDataProvider;
    void recoverAuditPending(notifProvider);

    return { ok: true };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : "AUDIT_WRITE_FAILED";
    const notifProvider = provider as NotificationDataProvider;
    await queueAuditPending(notifProvider, input, actorUserId, errorMsg);
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
