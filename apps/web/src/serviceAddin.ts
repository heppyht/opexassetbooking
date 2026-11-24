/*───────────────────── OPEX Asset Booking – MyGeotab Service Add-In ─────────────────────*/
/* Service Add-In entry point. Runs in a WebWorker background context within MyGeotab.
   Polls AddInData for pending notifications and delivers them via service.notifications.show().
   Also performs periodic audit reconciliation to detect security-relevant anomalies
   in booking and audit records. Registered via: geotab.addin.service = (service) => { ... } */

/*───────────────────── Types ─────────────────────*/

import type { OpexReconciliationFinding, ReconciliationFindingType, ResolvedBooking, OpexBookingAudit, ReconciliationRunState } from "./data/types";

type LocalStorageService = {
  get?: (key: string) => Promise<string | null>;
  set?: (key: string, value: string) => Promise<void>;
  remove?: (key: string) => Promise<void>;
};

type ServiceAddIn = {
  notifications?: {
    show?: (opts: {
      title: string;
      text: string;
      type?: "info" | "warning" | "error" | "success";
      duration?: number;
      buttons?: unknown[];
    }) => unknown;
  };
  api?: {
    call?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    getSession?: () => Promise<{ userName?: string; database?: string; server?: string }>;
  };
  localStorage?: LocalStorageService;
};

type OpexNotification = {
  id: string;
  eventId: string;
  idempotencyKey: string;
  type: string;
  recipient_user_id: string;
  related_booking_id: string | null;
  title: string;
  message: string;
  is_read: boolean;
  delivery_status: "pending" | "delivered" | "failed";
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
};

type AddInDataDetails = string | Record<string, unknown>;
type AddInDataRecord = { addInId?: string; details?: AddInDataDetails; id?: string };

/*───────────────────── Constants ─────────────────────*/

const ADDIN_ID_KEY = "opex-vbm-addin-id";
const DEFAULT_ADDIN_ID = "aDJjMmVmZWMtYzU1OC00MTJ";
const NOTIFICATION_GROUP_ID = "GroupCompanyId";
const POLL_INTERVAL_MS = 30000; // 30 seconds
const MAX_NOTIFICATIONS_PER_POLL = 10;
const MAX_NOTIFICATION_CALLS_PER_MINUTE = 6;
const MAX_VISIBLE_NOTIFICATIONS = 2;
const ROLLING_WINDOW_MS = 60000; // 1 minute
const RETRY_BACKOFF_MS = 60000; // 1 minute between retries

/* Reconciliation engine constants */
const RECONCILIATION_INTERVAL_MS = 300000; // 5 minutes between reconciliation runs
const RECONCILIATION_STATE_KEY = "opex-vbm-reconciliation-state";
const MAX_FINDINGS_PER_RUN = 50;
const MAX_FINDING_NOTES_LENGTH = 500;

/* Reconciliation lock TTL.
   localStorage does not provide atomic distributed locking — this is a
   best-effort single-origin mechanism shared across tabs and instances.
   A stale lock is recovered when lock_acquired_at + LOCK_TTL_MS has
   elapsed and no successful write has renewed it. */
const LOCK_TTL_MS = 300000; // 5 minutes — matches reconciliation interval

/* Generate a per-instance lock owner identifier. Not cryptographically
   secure — used only to distinguish one Service Add-In instance from
   another within the same origin. */
function generateLockOwner(): string {
  const random = Math.random().toString(36).slice(2, 12);
  const timestamp = Date.now().toString(36);
  return `owner-${timestamp}-${random}`;
}

/*───────────────────── Helpers ─────────────────────*/

function deserializeNotification(details: AddInDataDetails): OpexNotification | null {
  try {
    return (typeof details === "string" ? JSON.parse(details) : details) as OpexNotification;
  } catch {
    return null;
  }
}

async function apiCall<T>(service: ServiceAddIn, method: string, params: Record<string, unknown>): Promise<T | null> {
  try {
    const call = service.api?.call;
    if (typeof call !== "function") return null;
    const result = await call(method, params);
    return (result as T) ?? null;
  } catch {
    return null;
  }
}

async function getAddInId(service: ServiceAddIn): Promise<string | null> {
  try {
    const localStorage = service.localStorage;
    if (!localStorage || typeof localStorage.get !== "function") return null;
    const addInId = await localStorage.get(ADDIN_ID_KEY);
    return addInId ?? DEFAULT_ADDIN_ID;
  } catch {
    return DEFAULT_ADDIN_ID;
  }
}

/*───────────────────── Notification Rate Limiter ─────────────────────*/
/* Enforces MyGeotab rate limits:
   - Maximum 6 notification calls per rolling minute
   - Maximum 2 visible notifications at a time */

type CallRecord = { timestamp: number };

class NotificationRateLimiter {
  private calls: CallRecord[] = [];
  private visibleCount = 0;

  canCall(): boolean {
    const now = Date.now();
    // Remove calls outside the rolling window
    this.calls = this.calls.filter(c => now - c.timestamp < ROLLING_WINDOW_MS);
    return this.calls.length < MAX_NOTIFICATION_CALLS_PER_MINUTE;
  }

  recordCall(): void {
    this.calls.push({ timestamp: Date.now() });
  }

  canShow(): boolean {
    return this.visibleCount < MAX_VISIBLE_NOTIFICATIONS;
  }

  incrementVisible(): void {
    this.visibleCount += 1;
  }

  decrementVisible(): void {
    if (this.visibleCount > 0) this.visibleCount -= 1;
  }
}

const rateLimiter = new NotificationRateLimiter();

/*───────────────────── Reconciliation State Management ─────────────────────*/
/* Persists reconciliation run state in localStorage to prevent overlapping
   runs within the same Service Add-In instance and to track last run/error.
   Lock fields (lock_owner, lock_acquired_at) provide best-effort protection
   against overlapping runs across tabs/instances within the same origin.
   localStorage does not provide atomic distributed locking. */

function getReconciliationStateKey(): string {
  return RECONCILIATION_STATE_KEY;
}

async function readReconciliationState(
  localStorage: LocalStorageService | undefined,
): Promise<ReconciliationRunState | null> {
  try {
    if (!localStorage || typeof localStorage.get !== "function") return null;
    const raw = await localStorage.get(getReconciliationStateKey());
    if (!raw) return null;
    return JSON.parse(raw) as ReconciliationRunState;
  } catch {
    return null;
  }
}

async function writeReconciliationState(
  localStorage: LocalStorageService | undefined,
  state: Partial<ReconciliationRunState>,
): Promise<void> {
  try {
    if (!localStorage || typeof localStorage.set !== "function") return;
    const existing = await readReconciliationState(localStorage);
    const merged: ReconciliationRunState = {
      last_successful_reconciliation: null,
      last_error: null,
      last_error_timestamp: null,
      last_run_timestamp: null,
      reconciliation_in_progress: false,
      total_findings: 0,
      open_findings: 0,
      lock_owner: null,
      lock_acquired_at: null,
      ...existing,
      ...state,
    };
    await localStorage.set(getReconciliationStateKey(), JSON.stringify(merged));
  } catch {
    // State persistence failures must not block reconciliation
  }
}

async function markReconciliationInProgress(
  localStorage: LocalStorageService | undefined,
): Promise<void> {
  await writeReconciliationState(localStorage, {
    reconciliation_in_progress: true,
    last_run_timestamp: new Date().toISOString(),
    lock_owner: generateLockOwner(),
    lock_acquired_at: new Date().toISOString(),
  });
}

/* Check whether a reconciliation lock is stale — i.e., the lock was acquired
   more than LOCK_TTL_MS ago and has not been renewed. Returns false when
   there is no lock or when the lock is still fresh. */
function isLockStale(state: ReconciliationRunState | null): boolean {
  if (!state || !state.reconciliation_in_progress) return false;
  if (!state.lock_acquired_at) return false;
  const acquired = new Date(state.lock_acquired_at).getTime();
  if (Number.isNaN(acquired)) return false;
  return Date.now() - acquired > LOCK_TTL_MS;
}

/* Safely recover a stale lock. Only clears the lock when it is stale — an
   active lock held by a different instance is never cleared. Returns true
   when the lock was recovered, false when no recovery was needed or possible. */
async function recoverStaleLock(
  localStorage: LocalStorageService | undefined,
): Promise<boolean> {
  const state = await readReconciliationState(localStorage);
  if (!state || !isLockStale(state)) return false;
  await writeReconciliationState(localStorage, {
    reconciliation_in_progress: false,
    lock_owner: null,
    lock_acquired_at: null,
  });
  return true;
}

async function markReconciliationComplete(
  localStorage: LocalStorageService | undefined,
  result: { totalFindings: number; openFindings: number; error?: string },
): Promise<void> {
  await writeReconciliationState(localStorage, {
    reconciliation_in_progress: false,
    last_successful_reconciliation: result.error
      ? undefined
      : new Date().toISOString(),
    last_error: result.error ?? null,
    last_error_timestamp: result.error ? new Date().toISOString() : null,
    total_findings: result.totalFindings,
    open_findings: result.openFindings,
    lock_owner: null,
    lock_acquired_at: null,
  });
}

/*───────────────────── Diagnostic Logging ─────────────────────*/
function diagLog(message: string, detail?: unknown): void {
  try {
    if (typeof console !== "undefined" && console.log) {
      const detailStr = detail !== undefined ? ` | detail=${String(detail).slice(0, 100)}` : "";
      console.log(`[OPEX-VBM-ServiceAddIn] ${message}${detailStr}`);
    }
  } catch {
    // Logging must never throw
  }
}

/* Local AddInId validation for standalone Service Add-In bundle.
   Mirrors config/addinId.ts isValidAddInId but self-contained for WebWorker context. */
function isValidAddInIdLocal(value: string | null): boolean {
  if (!value || typeof value !== "string") return false;
  if (value.length !== 23) return false;
  if (!value.startsWith("a")) return false;
  return /^a[A-Za-z0-9_-]{22}$/.test(value);
}

/*───────────────────── Notification Delivery ─────────────────────*/

async function deliverPendingNotifications(service: ServiceAddIn): Promise<void> {
  diagLog("Service Add-In deliverPendingNotifications started");
  const addInId = await getAddInId(service);
  if (!addInId) {
    diagLog("Service Add-In deliverPendingNotifications: no AddInId, safe no-op");
    return;
  }
  diagLog("Service Add-In AddInId resolved", { addInIdValid: isValidAddInIdLocal(addInId) });

  // Retrieve pending notifications from AddInData
  const records = await apiCall<AddInDataRecord[]>(
    service,
    "Get",
    {
      typeName: "AddInData",
      search: {
        addInId,
        whereClause: `details.delivery_status = "pending"`,
        resultsLimit: MAX_NOTIFICATIONS_PER_POLL,
      },
    }
  );

  if (!records || records.length === 0) {
    diagLog("Service Add-In deliverPendingNotifications: no pending records");
    return;
  }

  diagLog("Service Add-In deliverPendingNotifications: pending records found", { count: records.length });

  for (const record of records) {
    // Re-check delivery status before processing (idempotency guard)
    const n = deserializeNotification(record.details ?? "");
    if (!n || n.delivery_status !== "pending") continue;

    // Rate limit: max 6 calls per rolling minute
    if (!rateLimiter.canCall()) {
      // Leave as pending for next poll cycle
      continue;
    }

    // Rate limit: max 2 visible notifications at a time
    if (!rateLimiter.canShow()) {
      // Leave as pending; will be retried when a visible slot frees up
      continue;
    }

    rateLimiter.recordCall();
    rateLimiter.incrementVisible();

    let delivered = false;
    try {
      const show = service.notifications?.show;
      if (typeof show === "function") {
        await show({
          title: n.title,
          text: n.message,
          type: "info",
          duration: 10,
        });
        delivered = true;
      }
    } catch {
      // Native notification failed – do NOT mark as delivered
    }

    // Update delivery status in AddInData
    n.delivery_status = delivered ? "delivered" : "failed";
    n.delivered_at = delivered ? new Date().toISOString() : n.delivered_at;
    n.updated_at = new Date().toISOString();

    await apiCall<unknown>(
      service,
      "Set",
      {
        typeName: "AddInData",
        entity: {
          addInId,
          id: record.id,
          details: n,
          groups: [{ id: NOTIFICATION_GROUP_ID }],
        },
      }
    );

    // Decrement visible count after notification duration expires
    setTimeout(() => {
      rateLimiter.decrementVisible();
    }, 10000); // matches duration: 10 seconds
  }
}

/*───────────────────── Audit Reconciliation Run ─────────────────────*/
/* Performs a single reconciliation cycle: fetches bookings, audits, and
   notifications from AddInData, runs the reconciliation engine, and stores
   findings back as reconciliation_finding records. Guarantees no overlapping
   runs via localStorage state tracking. API failures are handled gracefully
   and recorded in reconciliation state. */

async function fetchAddInDataRecords(
  service: ServiceAddIn,
  addInId: string,
  whereClause: string,
  resultsLimit: number,
): Promise<AddInDataRecord[]> {
  const records = await apiCall<AddInDataRecord[]>(
    service,
    "Get",
    {
      typeName: "AddInData",
      search: {
        addInId,
        whereClause,
        resultsLimit,
      },
    }
  );
  return records ?? [];
}

async function runReconciliation(
  service: ServiceAddIn,
): Promise<void> {
  diagLog("Service Add-In runReconciliation started");
  const addInId = await getAddInId(service);
  if (!addInId) {
    diagLog("Service Add-In runReconciliation: no AddInId, safe no-op");
    return;
  }

  const localStorage = service.localStorage;

  /* Prevent overlapping reconciliation runs.
     A fresh lock blocks new runs; a stale lock is recovered automatically. */
  const existingState = await readReconciliationState(localStorage);
  if (existingState?.reconciliation_in_progress && !isLockStale(existingState)) {
    diagLog("Service Add-In runReconciliation: active lock held, skipping");
    return;
  }
  if (existingState && isLockStale(existingState)) {
    const recovered = await recoverStaleLock(localStorage);
    diagLog("Service Add-In runReconciliation: stale lock recovered", { recovered });
  }

  await markReconciliationInProgress(localStorage);

  try {
    /* Fetch all relevant record types from AddInData */
    const [bookingRecords, auditRecords, notificationRecords] = await Promise.all([
      fetchAddInDataRecords(service, addInId, 'details.recordType = "booking"', MAX_FINDINGS_PER_RUN),
      fetchAddInDataRecords(service, addInId, 'details.recordType = "booking_audit"', MAX_FINDINGS_PER_RUN),
      fetchAddInDataRecords(service, addInId, 'details.recordType = "notification"', MAX_FINDINGS_PER_RUN),
    ]);

    /* Deserialize records */
    const bookings: ResolvedBooking[] = [];
    for (const r of bookingRecords) {
      const b = (typeof r.details === "string" ? JSON.parse(r.details) : r.details) as ResolvedBooking;
      if (b) bookings.push(b);
    }

    const audits: OpexBookingAudit[] = [];
    for (const r of auditRecords) {
      const a = (typeof r.details === "string" ? JSON.parse(r.details) : r.details) as OpexBookingAudit;
      if (a) audits.push(a);
    }

    const notifications: { id: string; booking_id: string; actor_user_id: string; created_at: string; type: string }[] = [];
    for (const r of notificationRecords) {
      const n = (typeof r.details === "string" ? JSON.parse(r.details) : r.details) as { id: string; booking_id: string; actor_user_id: string; created_at: string; type: string };
      if (n) notifications.push(n);
    }

    /* Run reconciliation engine via dynamic import (works with standalone tsc build) */
    const auditTrailModule = await import("./audit/auditTrail");
    const reconcileAuditEnhanced = auditTrailModule.reconcileAuditEnhanced;
    const toOpexReconciliationFinding = auditTrailModule.toOpexReconciliationFinding;

    const findings = reconcileAuditEnhanced(bookings, audits, notifications);

    /* Limit findings per run to avoid overwhelming AddInData */
    const limitedFindings = findings.slice(0, MAX_FINDINGS_PER_RUN);

    /* Convert to storage format and store each finding */
    let storedCount = 0;
    for (const finding of limitedFindings) {
      const storageFinding = toOpexReconciliationFinding(finding);
      /* Truncate notes if too long */
      if (storageFinding.notes && storageFinding.notes.length > MAX_FINDING_NOTES_LENGTH) {
        storageFinding.notes = storageFinding.notes.slice(0, MAX_FINDING_NOTES_LENGTH) + "…";
      }
      try {
        const setResult = await apiCall<unknown>(
          service,
          "Set",
          {
            typeName: "AddInData",
            entity: {
              addInId,
              id: storageFinding.id,
              details: storageFinding,
              groups: [{ id: NOTIFICATION_GROUP_ID }],
            },
          }
        );
        if (setResult !== null) storedCount++;
      } catch {
        /* Individual finding storage failure is not critical */
      }
    }

    const openCount = limitedFindings.filter(f => f.reconciliation_status === "OPEN").length;
    await markReconciliationComplete(localStorage, {
      totalFindings: limitedFindings.length,
      openFindings: openCount,
    });

    diagLog("Service Add-In runReconciliation completed", {
      findings: limitedFindings.length,
      stored: storedCount,
      open: openCount,
    });
  } catch (err) {
    diagLog("Service Add-In runReconciliation error", { error: String(err) });
    await markReconciliationComplete(localStorage, {
      totalFindings: 0,
      openFindings: 0,
      error: String(err),
    });
  }
}

/*───────────────────── Service Add-In Entry Point ─────────────────────*/

/* WebWorker-compatible registration. Uses self.geotab instead of window.geotab
   because Service Add-Ins run in a WebWorker context where window is unavailable.
   Guarded with typeof checks so the module can be imported in non-WebWorker
   environments (e.g., unit tests) without throwing. */

if (typeof self !== "undefined") {
  const selfGlobal = self as unknown as {
    geotab?: {
      addin?: {
        service?: (service: ServiceAddIn) => void;
      } | null;
    } | null;
  };

  selfGlobal.geotab = selfGlobal.geotab ?? {};
  selfGlobal.geotab.addin = selfGlobal.geotab.addin ?? {};

  selfGlobal.geotab.addin.service = (service: ServiceAddIn) => {
    diagLog("Service Add-In registered, initializing notification delivery and reconciliation");
    // Deliver pending notifications on startup
    deliverPendingNotifications(service).catch(() => {
      // Swallow errors – Service Add-In must not crash
    });

    // Periodic polling for new pending notifications
    const notificationInterval = setInterval(() => {
      deliverPendingNotifications(service).catch(() => {
        // Swallow errors
      });
    }, POLL_INTERVAL_MS);

    // Periodic audit reconciliation (longer interval than notification polling)
    const reconciliationInterval = setInterval(() => {
      runReconciliation(service).catch(() => {
        // Swallow errors – Service Add-In must not crash
      });
    }, RECONCILIATION_INTERVAL_MS);

    // Keep the service alive (WebWorker context)
    return () => {
      diagLog("Service Add-In cleanup, stopping notification polling and reconciliation");
      clearInterval(notificationInterval);
      clearInterval(reconciliationInterval);
    };
  };
}

/*───────────────────── Module export (for bundling and testing) ─────────────────────*/

export {
  NotificationRateLimiter,
  getAddInId,
  deliverPendingNotifications,
  runReconciliation,
  readReconciliationState,
  markReconciliationInProgress,
  markReconciliationComplete,
  isLockStale,
  recoverStaleLock,
  type ServiceAddIn,
  type OpexNotification,
  type LocalStorageService,
  type ReconciliationRunState,
};
