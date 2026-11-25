/*───────────────────── Canonical Booking Audit Event ─────────────────────*/
/* Builds, serializes, and normalizes canonical booking audit events
   (recordType "bookingAudit") for AddInData storage.

   Design principles:
   - One logical audit event per successful business operation (immutable).
   - Only changed fields stored in `changes` with `from`/`to`.
   - Actor derived from the verified server-side principal (never browser-trusted).
   - Legacy "booking_audit" records normalized in memory, never rewritten.
   - Compact JSON: no nested JSON strings, no full booking copies, minimal metadata.
   - No credentials or session IDs stored or logged. */

import type {
  BookingAction,
  ActorInfo,
  AuditChange,
  AuditMetadata,
  OpexBookingAuditV2,
  NormalizedAuditEvent,
  isCanonicalAudit,
  normalizeAuditRecord,
} from "./types";

/*───────────────────── Canonical event builder ─────────────────────*/

export type BuildBookingAuditInput = {
  bookingKey: string;
  action: BookingAction;
  actor: ActorInfo;
  occurredAtUtc?: string;
  previousStatus: string | null;
  newStatus: string | null;
  changes: Record<string, AuditChange>;
  metadata?: Partial<AuditMetadata>;
  auditKey?: string;
};

/* Build a canonical booking audit event. auditKey defaults to a generated
   business id so every event is uniquely keyed and immutable. */
export function buildBookingAuditEvent(input: BuildBookingAuditInput): OpexBookingAuditV2 {
  const auditKey = input.auditKey ?? generateCanonicalAuditKey();
  const occurredAtUtc = input.occurredAtUtc ?? new Date().toISOString();
  return {
    recordType: "bookingAudit",
    schemaVersion: 1,
    auditKey,
    bookingKey: input.bookingKey,
    action: input.action,
    actor: {
      userId: input.actor.userId,
      ...(input.actor.userName ? { userName: input.actor.userName } : {}),
      ...(input.actor.role ? { role: input.actor.role } : {}),
    },
    occurredAtUtc,
    previousStatus: input.previousStatus ?? null,
    newStatus: input.newStatus ?? null,
    changes: input.changes,
    metadata: {
      ...(input.metadata ?? {}),
      source: input.metadata?.source ?? "OPEX_VBM",
      mode: input.metadata?.mode ?? "ADDIN_DATA",
    },
  };
}

/* Generate a unique audit key. Not cryptographically secure; used for
   dedup and idempotency, not access control. */
export function generateCanonicalAuditKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `audit-${crypto.randomUUID()}`;
  }
  return `audit-${"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  })}`;
}

/* Compute only the fields that actually changed between previous and next
   snapshots. Returns an empty object when nothing changed. Null means the
   field did not previously exist. */
export function computeChanges(
  previous: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
  fields: string[] = [],
): Record<string, AuditChange> {
  const changed: Record<string, AuditChange> = {};
  const keys: string[] = [
    "status", "startAt", "endAt", "destination", "purpose",
    "assetId", "driverId", ...fields,
  ];
  for (const k of keys) {
    const p = previous?.[k] ?? null;
    const n = next?.[k] ?? null;
    if (p !== n) {
      changed[k] = { from: p, to: n };
    }
  }
  return changed;
}

/*───────────────────── Serialization ─────────────────────*/

/* Serialize a canonical audit event to a JSON string for AddInData storage.
   Never serializes nested JSON as a string — `changes` stays a structured
   object so it remains queryable and readable. */
export function serializeBookingAudit(event: OpexBookingAuditV2): string {
  return JSON.stringify(event);
}

/* Deserialize a stored AddInData record into a canonical audit event.
   Returns null when the record is not a valid canonical bookingAudit event. */
export function deserializeBookingAudit(details: string | Record<string, unknown> | undefined): OpexBookingAuditV2 | null {
  if (!details) return null;
  const obj = typeof details === "string" ? safeParse(details) : (details as Record<string, unknown>);
  if (!obj || obj.recordType !== "bookingAudit") return null;
  return obj as unknown as OpexBookingAuditV2;
}

function safeParse(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* Measure the serialized payload size (UTF-8 bytes) of an audit event. */
export function auditPayloadSizeBytes(event: OpexBookingAuditV2): number {
  return new TextEncoder().encode(serializeBookingAudit(event)).length;
}

/*───────────────────── Legacy compatibility (normalization layer) ─────────────────────*/

/* Re-exported from types for convenience. Kept here so consumers import the
   normalization layer from a single dedicated module. */
export { isCanonicalAudit, normalizeAuditRecord } from "./types.ts";
