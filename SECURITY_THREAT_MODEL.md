# Security Threat Model

**Status:** Documented + mock-tested
**Tenant validation:** NOT performed — requires access to `opex_trial` tenant

## Threat Categories

### T1: Direct AddInData Write (Add/Set/Remove)

**Description:** An ordinary employee with Default User clearance opens browser console and calls `geotab.api.call("Add", { typeName: "AddInData", ... })` directly, bypassing the trusted authorization Worker.

**Platform behavior:** MyGeotab Storage API docs confirm Default User clearance includes Add/Set/Get/Remove for AddInData objects.

**Can MyGeotab prevent?** ❌ No — AddInData permissions are clearance-based, not record-based. `ManageAddInData` is a system-level security clearance.

**Can the application prevent?** ⚠️ Partially — All UI-initiated protected booking writes (create, update, submit, approve, reject, cancel, reschedule) now route through the Cloudflare Authorization Worker (`/authz/execute`) instead of direct browser AddInData calls. The Worker independently verifies the session, enforces server-side RBAC, computes SHA-256 payload fingerprints, enforces idempotency keys, and executes writes using a service account. However, the client still holds valid session credentials and *can* call MyGeotab API directly from the console — the application cannot prevent this at the platform level.

**Mitigation:**
- Trusted authorization Worker (`/authz/execute`) enforces server-side RBAC for all UI-initiated protected writes (Phase 24.6.3)
- SHA-256 payload fingerprint verification (Worker-side) detects payload tampering
- Server-side idempotency keys prevent duplicate writes under the same key
- Service account performs AddInData writes (not the user's session)
- Custom security identifiers can gate Add-In menu visibility (not API access)
- Service Add-In reconciliation (Phase 18.3) periodically scans AddInData and detects unauthorized records
- Security Monitoring Dashboard (Phase 18.6) displays reconciliation findings for administrator review

**Residual risk:** High — employees can create fake bookings, modify status to APPROVED, or delete bookings directly via browser console. All UI write paths are now Worker-mediated, but direct console access remains a platform limitation. Detection via reconciliation reduces but does not eliminate this risk.

## Protected Write Execution Path (Phase 24.6.3)

All protected booking business writes now follow this execution flow:

```
Frontend UI → provider method → serverAuthz.execute() → POST /authz/execute
   → Session Verification → Server-side RBAC → Payload Validation
   → SHA-256 Fingerprint → Idempotency Check → Service-account AddInData Write
   → Response → Frontend emits canonical audit event → Cache invalidation
```

Operations routed through Worker:
- `create_booking` (add operation)
- `update_booking_status` (set operation — approve/reject/assign/complete/cancel)
- `delete_booking` (remove operation)

Operations NOT routed through Worker (internal/system writes, not user-facing business writes):
- Canonical audit event creation (`bookingAudit`)
- Notification creation/delivery status updates
- Audit pending/dead-letter records
- Read operations (all direct AddInData Gets, bounded)

### T2: Direct AddInData Read (Get)

**Description:** Employee reads all AddInData records for the AddInId, potentially accessing other users' bookings.

**Platform behavior:** Default User clearance includes Get for AddInData.

**Can MyGeotab prevent?** ❌ No — Get is a platform-level permission.

**Mitigation:** AddInId isolation — records are scoped to the Add-In's AddInId, but all users of the Add-In can see all its records.

**Residual risk:** Medium — confidentiality of booking data between users of the same Add-In.

### T3: Audit Record Tampering

**Description:** Employee modifies or deletes audit records via AddInData.Set/Remove to cover tracks of unauthorized actions.

**Platform behavior:** Default User clearance includes Set/Remove for AddInData, including audit records.

**Can MyGeotab prevent?** ❌ No.

**Mitigation:** Server records verified actor ID at write time (Phase 6). Direct client writes to audit records are not covered by server audit trail. Reconciliation engine (Phase 18.2) detects records modified or deleted without audit trail.

**Canonical audit (Phase 24.5):** Audit events are written as immutable `bookingAudit` records with a unique `auditKey`; each business action creates a new record (never overwrites). Actor identity is derived from the verified MyGeotab principal at write time and never accepted from the browser. Legacy `booking_audit` records are normalized in memory and never rewritten.

**Dual-format reconciliation (Phase 24.5.1):** The Service Add-In reconciliation loop retrieves both `booking_audit` (legacy) and `bookingAudit` (canonical) formats via two separate bounded `Get` queries (AddInData does not support `OR` conditions), normalizes both through `normalizeAuditRecord`, and reconciles them together. Canonical events are deduplicated/flagged by `auditKey` (new `DUPLICATE_AUDIT_EVENT` finding, HIGH severity); legacy records without `auditKey` use existing compatibility behavior. Malformed records that cannot be normalized are preserved as insufficient-evidence entries rather than silently discarded.

API request impact: reconciliation performs 4 bounded `Get` calls per run (booking, booking_audit, bookingAudit, notification) — one additional call versus the Phase 24.5 baseline (3 calls) to retrieve the canonical `bookingAudit` format.

**Residual risk:** High — audit integrity cannot be guaranteed against direct client writes. Application-level immutability does not guarantee platform-level tamper-proof protection: users with sufficient MyGeotab AddInData clearance may still modify or delete audit records directly. Reconciliation detects tampering after the fact; it does not prevent direct AddInData manipulation or provide tamper-proof storage.

### T4: Unauthorized Status Change

**Description:** Employee changes a booking from PENDING_APPROVAL to APPROVED without going through the approval workflow.

**Platform behavior:** Direct AddInData.Set allows status modification.

**Can MyGeotab prevent?** ❌ No.

**Mitigation:** Trusted authorization Worker validates transitions and actor identity before any server-mediated write. Direct client writes bypass this. Reconciliation engine (Phase 18.2) detects unexpected status transitions and inconsistent booking states.

**Residual risk:** Critical — approval workflow can be bypassed entirely. Reconciliation detects the anomaly post-hoc.

### T5: Session ID Theft

**Description:** Attacker captures a user's MyGeotab session ID and uses it to call the authorization Worker.

**Platform behavior:** Session IDs are bearer credentials valid for 14 days.

**Mitigation:** Sessions transmitted over HTTPS only; never logged or stored; auto-refresh 1 day before expiry.

**Residual risk:** Low — short window, HTTPS-only transmission.

### T6: Service Account Compromise

**Description:** Attacker obtains service account credentials and writes directly to AddInData.

**Platform behavior:** Service account has ManageAddInData clearance (required for server-mediated writes).

**Mitigation:** Credentials stored as `wrangler secret put` (never in code); least-privilege service account mapped to EMPLOYEE role (cannot approve/reject/assign via server authz).

**Residual risk:** Low — secrets not in frontend bundle or git.

### T7: API Session Verification Expiration

**Description:** Expired MyGeotab sessions are used to call the authorization Worker.

**Mitigation:** `verifySession()` calls MyGeotab `Get User` with the session ID; invalid/expired sessions return authentication errors; Worker returns 401.

**Residual risk:** Low — server validates every request.

### T8: Missing Audit Events (Reconciliation Finding)

**Description:** A booking record exists without corresponding audit events, indicating either interrupted operations or direct client writes that bypassed the audit trail.

**Detection:** Reconciliation engine (Phase 18.2) compares booking records against expected audit actions for each status.

**Mitigation:** Findings stored as `reconciliation_finding` records in AddInData, displayed in Security Monitoring Dashboard (Phase 18.6). Evidence classified as LEGITIMATE_PARTIAL_WRITE, INTERRUPTED_OPERATION, POTENTIAL_UNAUTHORIZED_WRITE, or INSUFFICIENT_EVIDENCE.

**Residual risk:** Medium — detection capability implemented; remediation requires administrator review.

### T9: Booking State Inconsistency (Reconciliation Finding)

**Description:** A booking's status is inconsistent with its audit trail (e.g., APPROVED status without BOOKING_APPROVED audit event), version mismatch, duplicate records, or orphaned audit records.

**Detection:** Reconciliation engine (Phase 18.2) validates booking state against audit records, notification context, and version history.

**Mitigation:** Findings stored as `reconciliation_finding` records in AddInData. Booking state validation (Phase 18.5) in authz.ts provides server-side transition and state validation for UI-initiated operations.

**Residual risk:** Medium — detection capability implemented; server-side validation prevents new inconsistencies through the trusted Worker.

### T10: Canonical Audit Record Direct Manipulation (Phase 24.5)

**Description:** Canonical `bookingAudit` audit records are stored in AddInData and could be modified or deleted directly via AddInData.Set/Remove by a user with sufficient clearance, or a canonical record could be forged.

**Platform behavior:** Default User clearance includes Set/Remove/Get for AddInData, including canonical audit records.

**Can MyGeotab prevent?** ❌ No — AddInData permissions are clearance-based, not record-based.

**Mitigation:**
- Canonical records use a unique `auditKey` and are append-only (new record per event, never overwrite).
- Actor identity derived from verified server principal (never browser-trusted); `metadata.mode = "ADDIN_DATA"` marks server-written events.
- Reconciliation engine detects modified/deleted audit records, missing audit events, and actor attribution mismatches (classifies as RECORD_MODIFIED_WITHOUT_AUDIT, INVALID_ACTOR_ATTRIBUTION, MISSING_AUDIT_EVENT).
- Legacy `booking_audit` records normalized in memory; never rewritten.

**Residual risk:** High — platform-level tamper-proof protection is not available; detection is post-hoc.

---

## Canonical Booking Audit Event Architecture (Phase 24.5)

**Canonical schema (`recordType: "bookingAudit"`, `schemaVersion: 1`):**
- `auditKey`: unique identifier per audit event.
- `bookingKey`: reference to the associated booking.
- `action`: standardized business event (BOOKING_CREATED/UPDATED/SUBMITTED/APPROVED/REJECTED/CANCELLED/RESCHEDULED, plus legacy VEHICLE_ASSIGNED/DRIVER_ASSIGNED/BOOKING_COMPLETED).
- `actor`: `{ userId, userName?, role? }` derived from the verified MyGeotab principal.
- `occurredAtUtc`: ISO 8601 UTC timestamp (stored source of truth).
- `previousStatus` / `newStatus`: actual status transition.
- `changes`: only fields that actually changed, each with `from`/`to`; `null` when the field did not previously exist.
- `metadata`: minimal `{ source, mode }`; no session IDs or credentials.

**Design principles:**
- One logical audit event per successful business operation (immutable, append-only).
- Actor derived server-side from the verified principal; browser-provided identity never trusted or allowed to override; fail-closed when unverified in LIVE mode.
- Compact payload: only changed fields stored, bookings referenced by `bookingKey`, no full booking copies, no nested JSON strings.
- Measured payload: legacy `booking_audit` ≈ 917 bytes vs canonical `bookingAudit` ≈ 407 bytes (−55.6%) for a representative status transition.
- Backward compatible: legacy `booking_audit` records remain readable via a dedicated normalization layer (`normalizeAuditRecord`) and coexist with canonical records; no historical records rewritten or deleted.
- Reconciliation recognizes both canonical `bookingAudit` and legacy `booking_audit` formats.

## Attack Path Summary

| Attack | Platform Blocks? | App Blocks? | Residual Risk |
|---|---|---|---|
| Direct AddInData.Add | ❌ | ✅ Worker-mediated for UI writes | High |
| Direct AddInData.Set | ❌ | ✅ Worker-mediated for UI writes | Critical |
| Direct AddInData.Remove | ❌ | ✅ Worker-mediated for UI writes | High |
| Direct AddInData.Get | ❌ | ❌ | Medium |
| Audit tampering | ❌ | ❌ | High |
| Unauthorized status change | ❌ | ✅ Worker validates transitions | Critical |
| Missing audit events | ❌ | ⚠️ Detected by reconciliation | Medium |
| Booking state inconsistency | ❌ | ⚠️ Detected by reconciliation | Medium |
| Session ID theft | N/A | ⚠️ HTTPS only | Low |
| Service account compromise | N/A | Secrets only | Low |
| Expired session rejection | N/A | Server validates | Low |

## Security Controls Implemented

| Control | Phase | Status |
|---|---|---|
| Fail-closed identity resolution | 3 | ✅ Implemented |
| Role-based authorization (client) | 5 | ✅ Implemented |
| Actor identity validation in audit | 5 | ✅ Implemented |
| Optimistic locking (version checks) | 7 | ✅ Implemented |
| Trusted authorization Worker | 6 | ✅ Implemented |
| Server-mediated AddInData writes | 6 | ✅ Implemented |
| Session ID capture and verification | 6 | ✅ Implemented |
| Custom security identifiers (view gate) | 7 | ⚠️ Documented, not tested |
| Enhanced booking state validation | 18.5 | ✅ Implemented |
| Audit reconciliation engine | 18.2 | ✅ Implemented |
| Service Add-In reconciliation polling | 18.3 | ✅ Implemented |
| Reconciliation finding storage (AddInData) | 18.4 | ✅ Implemented |
| Audit integrity monitoring | 18.4 | ✅ Implemented |
| Security Monitoring Dashboard | 18.6 | ✅ Implemented |
| Automated reconciliation tests | 18.7 | ✅ Implemented |
| Canonical booking audit schema (`bookingAudit`) | 24.5 | ✅ Implemented |
| Server-side actor verification (fail-closed) | 24.5 | ✅ Implemented |
| Audit immutability + unique audit keys | 24.5 | ✅ Implemented |
| Legacy audit normalization layer | 24.5 | ✅ Implemented |
| Compact audit payload (`changes` only) | 24.5 | ✅ Implemented |
| Dual-format audit reconciliation (`booking_audit` + `bookingAudit`) | 24.5.1 | ✅ Implemented |
| Canonical duplicate detection by `auditKey` | 24.5.1 | ✅ Implemented |
| Malformed audit record preservation (insufficient-evidence) | 24.5.1 | ✅ Implemented |
| Audit normalization parity (types.ts vs serviceAddin.ts) | 24.6.1 | ✅ Implemented (parity tests) |
| Cross-session idempotency (read-before-write dedup) | 24.6.1 | ✅ Implemented (best-effort) |
| Worker-routed protected writes (`/authz/execute`) | 24.6.3 | ✅ Implemented |
| SHA-256 payload fingerprint enforcement | 24.6.3 | ✅ Implemented (Worker-side) |
| Server-side idempotency key enforcement | 24.6.3 | ✅ Implemented (Worker-side) |
| Deterministic canonical JSON serialization | 24.6.5 | ✅ Implemented (`canonicalize()` + `v1:` versioned fingerprints) |
| Internal write recipient validation | 24.6.5 | ✅ Implemented (`markAsRead`/`markDeliveryStatus`/`markAllAsRead` accept `actorUserId`) |
| Audit recovery duplicate prevention | 24.6.5 | ✅ Implemented (`recoverAuditPending` checks existing canonical audit) |
| Security regression tests | 24.6.5 | ✅ Implemented (17 canonicalization/fingerprint + 6 Worker routing + recovery tests) |

## Remediation Status (Phase 24.6.1)

### S-03: Audit Normalization Consistency — RESOLVED

`normalizeAuditRecord` and `isCanonicalAudit` exist in two locations:
- Shared implementation in `src/data/types.ts` (UI side)
- Inline copy in `src/serviceAddin.ts` (standalone Service Add-In build, which cannot statically import runtime values from `types.ts` due to `--module ESNext` without `allowImportingTsExtensions`)

**Remediation:** `normalizeAuditRecord` and `isCanonicalAudit` are now exported from `serviceAddin.ts`, and a dedicated parity test file (`test/auditNormalizationParity.test.mjs`, 10 tests) compares both implementations against canonical records, legacy records, missing optional fields, null values, malformed records, unknown record types, missing/invalid `auditKey`, and actor/status normalization. Both implementations produce identical output for all test cases.

**Residual risk:** LOW — the two copies must be kept in sync manually. Parity tests catch divergence but do not prevent it.

### S-04: Idempotency Durability — PARTIALLY RESOLVED

The in-memory `recentKeys` Set was cleared on page reload, allowing duplicate audit submissions after reload.

**Remediation:** `emitAuditEvent` now performs a cross-session dedup check via `provider.getAuditRecords(entityId)` before writing: if a canonical audit record with the same `auditKey` already exists in AddInData, the write is skipped (deduped). This survives page reloads.

**Limitation:** AddInData has no atomic compare-and-set, so exactly-once execution cannot be guaranteed. Two concurrent requests could both read "none exists" and both write. This race is detected post-hoc by reconciliation via `DUPLICATE_AUDIT_EVENT` findings (HIGH severity). The pending-audit queue handles write failures; no audit event is silently lost.

**Residual risk:** MEDIUM — concurrent duplicate writes are possible but detectable via reconciliation.

## Remediation Status (Phase 24.6.5)

### F-01: Deterministic Canonical JSON Serialization — RESOLVED

`computePayloadFingerprint()` previously used `JSON.stringify()` directly, which is not deterministic across object key insertion orders. Equivalent payloads with different key order could produce different fingerprints, causing false `IDEMPOTENCY_KEY_CONFLICT` errors or cache misses.

**Remediation:** Implemented `canonicalize()` in `apps/api/src/crypto.ts` — recursively sorts object keys lexicographically, preserves array element order, handles null/boolean/number/string deterministically, and rejects unsupported types (functions, symbols, BigInt, Date, Map, Set, etc.) rather than producing ambiguous output. Fingerprints are versioned with a `"v1:"` prefix so that changes to the canonicalization algorithm never silently reinterpret previously stored fingerprints. Old fingerprints (without prefix) are treated as new keys — no false conflict, but also no deduplication against them. This is intentional.

**Tests:** 17 canonicalization/fingerprint tests in `apps/api/test/security.test.mjs` covering key order independence, nested objects, array order, null/numeric/undefined handling, unsupported type rejection, version prefix, old-format incompatibility, and deterministic output.

**Residual risk:** LOW — previously stored idempotency records with old-format fingerprints will not match new canonical fingerprints, reducing dedup effectiveness for those records until they are overwritten by new writes.

### F-02: Idempotency Concurrency Risk — DOCUMENTED

AddInData has no transactions or atomic compare-and-set. Two concurrent requests with the same idempotency key could both pass the check before either stores the result, leading to duplicate writes.

**Remediation:** Documented limitation (no code change possible without platform support). `checkIdempotencyKey` validates key scoping (actor, action, bookingId) and payload fingerprint. Reconciliation detects duplicates via `DUPLICATE_AUDIT_EVENT` findings. Tests document the race condition.

**Residual risk:** MEDIUM — concurrent duplicate writes are possible but detectable via reconciliation.

### F-03: Audit Reliability — PARTIALLY RESOLVED

The Worker writes the booking, then the frontend emits the canonical audit event separately. This creates a failure window where a booking can succeed but its audit event is not written.

**Remediation:**
- `emitAuditEvent` performs cross-session dedup via `getAuditRecords` before writing, preventing duplicate audit events after page reload or retry.
- `recoverAuditPending` now checks if a canonical audit already exists for the same booking+action+actor before re-creating a pending audit record. If a canonical audit exists, the pending record is deleted and recovery is marked complete without creating a duplicate.
- Pending audit records contain correlation info (booking_id, action, actor_user_id, details) for recovery.
- Audit write failures do not cause the booking write to be rolled back; the booking persists and the audit is queued for recovery.

**Residual risk:** MEDIUM — a crash between Worker booking success and frontend audit write leaves a booking without an audit event. Detected post-hoc by reconciliation (`MISSING_AUDIT_EVENT`).

### F-04: Direct AddInData Write via Browser Console — PLATFORM LIMITATION

Ordinary employees with Default User clearance can call `geotab.api.call()` directly from browser console, bypassing the Worker entirely.

**Remediation:** All UI-initiated protected booking writes route through the Worker. Internal writes (notifications, audit, recovery) now include recipient ownership validation where actor context is available (`markAsRead`, `markDeliveryStatus`, `markAllAsRead` accept optional `actorUserId` and validate recipient match). `deleteAuditPending` validates that the target record is a genuine pending audit with a valid server record ID before deletion.

**Residual risk:** HIGH — platform limitation; cannot prevent direct console access. Reconciliation detects anomalies post-hoc.

### F-07: Security Regression Coverage — RESOLVED

Added comprehensive regression tests:
- Canonical JSON serialization: key order independence, nested objects, array order, null/numeric/undefined handling, unsupported type rejection (10 tests in `apps/api/test/security.test.mjs`)
- SHA-256 fingerprint: version prefix, old-format incompatibility, deterministic output, changed-field detection (6 tests)
- Idempotency: key scoping (actor/action/bookingId), missing key, race condition documentation (5 tests)
- Worker routing: create/update/delete route through Worker, no direct-write fallback, failure propagation, idempotency conflict propagation, DEMO mode fallback (6 tests in `apps/web/test/security.test.mjs`)
- Notification recipient validation: markAsRead/markDeliveryStatus/markAllAsRead accept actorUserId and validate recipient match
- Audit recovery: duplicate prevention when canonical audit already exists

**Residual risk:** LOW — tests cover all remediated findings; real Worker HTTP integration testing requires a deployed Worker.

## Tenant Validation Required (updated)

| Item | Status | Required Before Production |
|------|--------|---------------------------|
| Default User AddInData permissions | Documented only | ✅ Yes |
| Custom security identifier behavior | Documented only | ✅ Yes |
| Service account AddInData write | Documented only | ✅ Yes |
| Session ID from getSession() | Documented only | ✅ Yes |
| Rate limit enforcement | Documented only | ⚠️ Recommended |
| Add-In URL hyphen restriction | Documented | ✅ Yes (deployment blocker) |
| Reconciliation finding accuracy | Mock-tested | ✅ Yes (unit tests) |
| Security Dashboard rendering | Not tenant-tested | ✅ Yes (UI component) |
| Audit normalization parity (S-03) | Unit-tested | ✅ Yes |
| Cross-session idempotency (S-04) | Unit-tested | ✅ Yes |

---

**Bottom line:** MyGeotab AddInData does not provide record-level or operation-level authorization that can prevent ordinary employees from directly writing to AddInData. The trusted authorization Worker is a strong deterrent for UI-initiated operations but cannot prevent direct API calls from the browser console. Phase 18 adds detection capability via the audit reconciliation engine and Service Add-In polling, which identifies anomalies post-hoc for administrator review. Production deployment requires accepting this residual risk — reconciliation detects but does not prevent direct writes.
