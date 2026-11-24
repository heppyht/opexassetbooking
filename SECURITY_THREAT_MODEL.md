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
- Service Add-In reconciliation (recommended future work) can detect unauthorized records

**Residual risk:** High — employees can create fake bookings, modify status to APPROVED, or delete bookings directly.

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

**Mitigation:** Server records verified actor ID at write time (Phase 6). Direct client writes to audit records are not covered by server audit trail.

**Residual risk:** High — audit integrity cannot be guaranteed against direct client writes.

### T4: Unauthorized Status Change

**Description:** Employee changes a booking from PENDING_APPROVAL to APPROVED without going through the approval workflow.

**Platform behavior:** Direct AddInData.Set allows status modification.

**Can MyGeotab prevent?** ❌ No.

**Mitigation:** Trusted authorization Worker validates transitions and actor identity before any server-mediated write. Direct client writes bypass this.

**Residual risk:** Critical — approval workflow can be bypassed entirely.

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
| Service Add-In reconciliation | Future | ❌ Not implemented |

## Tenant Validation Required

| Item | Status | Required Before Production |
|---|---|---|
| Default User AddInData permissions | Documented only | ✅ Yes |
| Custom security identifier behavior | Documented only | ✅ Yes |
| Service account AddInData write | Documented only | ✅ Yes |
| Session ID from getSession() | Documented only | ✅ Yes |
| Rate limit enforcement | Documented only | ⚠️ Recommended |
| Add-In URL hyphen restriction | Documented | ✅ Yes (deployment blocker) |

---

**Bottom line:** MyGeotab AddInData does not provide record-level or operation-level authorization that can prevent ordinary employees from directly writing to AddInData. The trusted authorization Worker is a strong deterrent for UI-initiated operations but cannot prevent direct API calls from the browser console. Production deployment requires accepting this risk or implementing additional controls (Service Add-In reconciliation).
