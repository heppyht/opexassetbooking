# Architecture Decision Record — ADR-001

**Title:** Trusted Server-Side Authorization with AddInData as Primary Storage

**Status:** Proposed (branch `security/server-auth`)

**Date:** 2026-11-24

**Authors:** Kilo (software engineering agent)

## Context

The OPEX Asset Booking application was originally architected with a PostgreSQL database and Cloudflare Worker backend (Phase 1-3). Phase 3 migrated to native MyGeotab AddInData as the sole persistent storage, removing the external backend entirely.

Phase 5 identified a critical security gap: client-side RBAC (implemented in React) cannot prevent users from bypassing frontend authorization by directly calling AddInData methods from the browser console. MyGeotab documentation confirms that Default User clearance includes Add/Set/Get/Remove for AddInData objects — this is a platform-level permission that cannot be restricted per-Add-In through custom security identifiers.

Phase 6 implemented a trusted server-side authorization layer (Cloudflare Worker + Hono) that:
1. Verifies MyGeotab session IDs server-side
2. Resolves user roles from MyGeotab security clearances
3. Enforces authorization server-side for all protected booking operations
4. Performs AddInData writes using a service account (not the client)
5. Records the verified actor in audit history

## Decision

**Use a trusted authorization Worker as a server-side gate for all protected booking operations, while keeping AddInData as the primary application persistence layer.**

### Architecture

```
Client (React Add-In, GitHub Pages)
├── GET bookings/assets/users → AddInData (direct read, bounded queries)
├── Protected write (create_booking)
│   └── POST /authz/execute → Cloudflare Worker (Hono)
│       ├─ Verify sessionId → MyGeotab Get User API
│       ├─ Check roles → MyGeotab User record
│       ├─ Enforce RBAC (server-side)
│       ├─ SHA-256 payload fingerprint → computePayloadFingerprint
│       ├─ Idempotency key check → checkIdempotencyKey
│       ├─ Write booking → AddInData (service account)
│       └─ Store idempotency key → AddInData (service account)
│   → Frontend emits canonical audit event (bookingAudit)
├── Protected write (update_booking_status: approve/reject/assign/complete/cancel)
│   └── POST /authz/execute → Cloudflare Worker (Hono)
│       ├─ Same security pipeline as create_booking
│       ├─ Write booking update → AddInData (service account, Set operation)
│       └─ Store idempotency key → AddInData (service account)
│   → Frontend emits canonical audit event (bookingAudit)
├── Protected write (delete_booking)
│   └── POST /authz/execute → Cloudflare Worker (Hono)
│       ├─ Same security pipeline
│       ├─ Remove booking → AddInData (service account, Remove operation)
│       └─ Store idempotency key → AddInData (service account)
│   → Frontend emits canonical audit event (bookingAudit)
├── Audit writes (bookingAudit) → AddInData (frontend, direct — internal system write)
├── Notification writes → AddInData (frontend, direct — internal system write)
└── Read operations → AddInData (direct, no authz gate needed)
```

## Consequences

### Positive
- Server-side authorization enforcement for all UI-initiated protected booking operations (create, update, delete)
- SHA-256 payload fingerprint verification prevents payload tampering
- Server-side idempotency keys prevent duplicate writes under the same key
- Verified actor attribution in audit records (not spoofed client IDs)
- AddInData remains the sole persistent storage (no PostgreSQL)
- Service account credentials managed as Cloudflare secrets (not in frontend)
- CORS restricted to frontend origin only

### Negative
- Direct AddInData writes from browser console cannot be prevented at platform level (T1 residual risk)
- Audit writes occur from the frontend after Worker confirmation; if frontend crashes between Worker success and audit write, reconciliation detects MISSING_AUDIT_EVENT
- Additional infrastructure dependency (Cloudflare Worker)
- Service account session management (14-day expiry, auto-refresh)
- Client must be online to perform protected operations (no offline mode)
- Two AddInData queries per reconciliation run for dual-format audit support

### Neutral
- Read operations remain client-direct for performance
- Audit/notification/recovery writes remain frontend-direct (internal system writes, not user-facing business writes)
- Demo mode unchanged (in-memory, no server dependency)

### Audit Event Canonicalization (Phase 24.5)

Audit events are stored as canonical `bookingAudit` records (`recordType: "bookingAudit"`, `schemaVersion: 1`) in AddInData:
- `auditKey`: unique identifier per event (immutable, append-only).
- `bookingKey`: reference to the associated booking (no full booking copy).
- `action`: standardized business event name.
- `actor`: `{ userId, userName?, role? }` derived from the verified MyGeotab principal at write time; browser-provided identity never trusted.
- `occurredAtUtc`: ISO 8601 UTC timestamp (stored source of truth).
- `previousStatus` / `newStatus`: actual status transition.
- `changes`: only fields that changed, each with `from`/`to`; `null` when the field did not previously exist.
- `metadata`: minimal `{ source, mode }`; no session IDs or credentials.

Legacy `booking_audit` records remain readable via a normalization layer and are never rewritten or deleted. Reconciliation recognizes both formats.

### Audit Reconciliation Dual-Format Support (Phase 24.5.1)

The Service Add-In reconciliation loop (`runReconciliation`) retrieves both audit formats using two separate MyGeotab AddInData `Get` queries (AddInData does not support `OR` conditions):
- Legacy: `details.recordType = "booking_audit"`
- Canonical: `details.recordType = "bookingAudit"`

Both formats are normalized through the shared `normalizeAuditRecord` layer into a common `NormalizedAuditEvent` shape before reconciliation, so legacy and canonical records are compared together. Canonical events are deduplicated/flagged by `auditKey`; legacy records (no `auditKey`) use the existing compatibility behavior. Malformed records that cannot be normalized are preserved as insufficient-evidence entries rather than silently discarded.

API request impact: reconciliation performs 4 `Get` calls per run (booking, booking_audit, bookingAudit, notification) — one additional call versus the Phase 24.5 baseline (3 calls) to retrieve the canonical `bookingAudit` format. No unbounded reads are introduced; all queries are bounded by `MAX_FINDINGS_PER_RUN`.

Audit integrity remains application-level: reconciliation detects anomalies (missing audits, duplicate canonical events, invalid actor attribution, orphaned records) but cannot prevent direct AddInData manipulation at the platform level.

### Durable Idempotency (Phase 24.6.1)

`emitAuditEvent` uses deterministic `auditKey` values derived from `mode:entityId:action:previousStatus:newStatus:actorUserId:metadata`. Two layers of dedup protect against duplicate audit events:

1. **In-session dedup** (`recentKeys` Set): prevents duplicate writes within a single page session.
2. **Cross-session dedup** (read-before-write via `provider.getAuditRecords(entityId)`): before writing, checks if a canonical audit record with the same `auditKey` already exists in AddInData. Survives page reloads.

**Limitation:** AddInData has no atomic compare-and-set or transactions. Exactly-once execution cannot be guaranteed. Two concurrent requests with the same `auditKey` could both read "none exists" and both write. This race is detected post-hoc by reconciliation via `DUPLICATE_AUDIT_EVENT` findings. The pending-audit queue handles write failures; no audit event is silently lost.

### Audit Normalization Parity (Phase 24.6.1)

`normalizeAuditRecord` and `isCanonicalAudit` exist in two locations:
- `src/data/types.ts` — shared implementation used by UI-side code
- `src/serviceAddin.ts` — inline copy required because the standalone Service Add-In build (`--module ESNext`, no `allowImportingTsExtensions`) cannot statically import runtime values from `types.ts`

Both copies are exported from `serviceAddin.ts` and verified identical by `test/auditNormalizationParity.test.mjs` (10 tests covering canonical records, legacy records, missing optional fields, null values, malformed records, unknown record types, missing/invalid `auditKey`, and actor/status normalization).

### Deterministic Canonical JSON Serialization (Phase 24.6.5)

`computePayloadFingerprint()` previously used `JSON.stringify()` directly, which is not deterministic across object key insertion orders. Equivalent payloads with different key order could produce different fingerprints, causing false `IDEMPOTENCY_KEY_CONFLICT` errors or cache misses.

**Remediation:** Implemented `canonicalize()` in `apps/api/src/crypto.ts`:
- Recursively sorts object keys lexicographically
- Preserves array element order
- Handles `null`, `boolean`, `number`, `string` deterministically
- Rejects unsupported types (functions, symbols, BigInt, Date, Map, Set, etc.) rather than producing ambiguous output
- Fingerprints versioned with `"v1:"` prefix so algorithm changes never silently reinterpret stored fingerprints

**Tests:** 17 canonicalization/fingerprint tests in `apps/api/test/security.test.mjs`.

### Internal Write Authorization (Phase 24.6.5)

Internal write methods (notifications, audit, recovery) are called from trusted app context (NotificationEngine, emitAuditEvent), but are technically callable from browser console since the user holds session credentials. Defense-in-depth remediations:

- `markAsRead(notificationId, actorUserId?)` — validates `recipient_user_id` matches `actorUserId` when provided
- `markDeliveryStatus(notificationId, status, actorUserId?)` — same recipient validation
- `markAllAsRead(userId, actorUserId?)` — validates `userId === actorUserId` when provided
- `deleteAuditPending(id)` — validates target is a genuine `booking_audit` pending record with non-empty server record ID before deletion

These validations are optional (parameter undefined = no enforcement) to preserve DEMO mode and backward compatibility. Callers in `App.tsx` pass the verified `actorId`.

**Residual risk:** Direct browser console access to these provider methods remains possible (platform limitation T1/T4). Reconciliation detects anomalies post-hoc.

### Audit Reliability (Phase 24.6.5)

**Crash window:** Worker writes booking → frontend emits canonical audit separately. A crash between Worker success and audit write leaves a booking without an audit event.

**Remediation:**
- `emitAuditEvent` cross-session dedup (`getAuditRecords` check before write) prevents duplicate audit events after reload/retry.
- `recoverAuditPending` checks if a canonical audit already exists for the same booking+action+actor before re-creating a pending audit record. If canonical audit exists, the pending record is deleted without creating a duplicate.
- Audit write failures do not roll back the booking write; booking persists and audit is queued for recovery via the pending-audit queue with exponential backoff.

**Residual risk:** MEDIUM — crash window between Worker booking success and frontend audit write cannot be eliminated without platform-level transactions. Detected post-hoc by reconciliation (`MISSING_AUDIT_EVENT`).

## Open Questions / Future Work

1. **Service Add-In validation:** A background Service Add-In could reconcile AddInData records and flag/remove unauthorized ones (direct client writes).
2. **Custom security identifiers:** Define `"securityIds": [{"name": "Manage OPEX Bookings", ...}]` in Add-In configuration for granular view control (does not affect AddInData API permissions).
3. **Session verification caching:** Cache verified sessions to reduce MyGeotab API calls (respect rate limits).
4. **Add-In URL character restriction:** The GitHub Pages URLs (`https://heppyh.github.io/opexassetbooking/` and `.../serviceAddin.js`) were verified character by character and contain no hyphen (`-`), at sign (`@`), or hash (`#`). They satisfy Geotab's requirement for externally hosted Add-In URLs (see DEPLOYMENT.md section 2).

## Related Documents

- SECURITY_PERMISSION_MATRIX.md — AddInData permission matrix
- SECURITY_THREAT_MODEL.md — Threat model with attack paths
- DEPLOYMENT.md — Deployment guide
- ARCHITECTURE.md — Original architecture notes
