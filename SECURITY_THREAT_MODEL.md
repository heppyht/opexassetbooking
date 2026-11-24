# Security Threat Model

**Status:** Documented + mock-tested
**Tenant validation:** NOT performed — requires access to `opex_trial` tenant

## Threat Categories

### T1: Direct AddInData Write (Add/Set/Remove)

**Description:** An ordinary employee with Default User clearance opens browser console and calls `geotab.api.call("Add", { typeName: "AddInData", ... })` directly, bypassing the trusted authorization Worker.

**Platform behavior:** MyGeotab Storage API docs confirm Default User clearance includes Add/Set/Get/Remove for AddInData objects.

**Can MyGeotab prevent?** ❌ No — AddInData permissions are clearance-based, not record-based. `ManageAddInData` is a system-level security clearance.

**Can the application prevent?** ❌ No — the client holds valid session credentials and can call MyGeotab API directly.

**Mitigation:**
- Trusted authorization Worker (Phase 6) enforces server-side RBAC for UI-initiated operations
- Custom security identifiers can gate Add-In menu visibility (not API access)
- Service Add-In reconciliation (Phase 18.3) periodically scans AddInData and detects unauthorized records
- Security Monitoring Dashboard (Phase 18.6) displays reconciliation findings for administrator review

**Residual risk:** High — employees can create fake bookings, modify status to APPROVED, or delete bookings directly. Detection via reconciliation reduces but does not eliminate this risk.

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

**Residual risk:** High — audit integrity cannot be guaranteed against direct client writes. Reconciliation detects tampering after the fact.

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

---

## Attack Path Summary

| Attack | Platform Blocks? | App Blocks? | Residual Risk |
|---|---|---|---|
| Direct AddInData.Add | ❌ | ❌ | High |
| Direct AddInData.Set | ❌ | ❌ | Critical |
| Direct AddInData.Remove | ❌ | ❌ | High |
| Direct AddInData.Get | ❌ | ❌ | Medium |
| Audit tampering | ❌ | ❌ | High |
| Unauthorized status change | ❌ | ❌ | Critical |
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

## Tenant Validation Required

| Item | Status | Required Before Production |
|---|---|---|
| Default User AddInData permissions | Documented only | ✅ Yes |
| Custom security identifier behavior | Documented only | ✅ Yes |
| Service account AddInData write | Documented only | ✅ Yes |
| Session ID from getSession() | Documented only | ✅ Yes |
| Rate limit enforcement | Documented only | ⚠️ Recommended |
| Add-In URL hyphen restriction | Documented | ✅ Yes (deployment blocker) |
| Reconciliation finding accuracy | Mock-tested | ✅ Yes (unit tests) |
| Security Dashboard rendering | Not tenant-tested | ✅ Yes (UI component) |

---

**Bottom line:** MyGeotab AddInData does not provide record-level or operation-level authorization that can prevent ordinary employees from directly writing to AddInData. The trusted authorization Worker is a strong deterrent for UI-initiated operations but cannot prevent direct API calls from the browser console. Phase 18 adds detection capability via the audit reconciliation engine and Service Add-In polling, which identifies anomalies post-hoc for administrator review. Production deployment requires accepting this residual risk — reconciliation detects but does not prevent direct writes.
