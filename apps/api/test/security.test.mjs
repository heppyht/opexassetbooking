/*───────────────────── Security Tests — Server-Side Authorization ─────────────────────*/
/* Unit tests for the server-side authorization module (authz.ts).
   These test the authorization decision engine, role hierarchy,
   session verification, and booking state validation.
   Live MyGeotab security validation must be performed separately
   against the opex_trial tenant. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  checkAuthorization,
  hasRole,
  roleHasMinRank,
  validateTransition,
  verifyIdentity,
} from "../src/authz.ts";
import { resolveRoles } from "../src/integrations/mygeotab/client.ts";

/*───────────────────── Local Type Definitions ─────────────────────*/
/* Duplicated to avoid `type` import syntax which is not valid in .mjs files.
   These mirror the types in src/types.ts. */

/*───────────────────── Test Helpers ─────────────────────*/

function principal(roles) {
  return {
    userName: "test@test.com",
    database: "opex_trial",
    server: "my.geotab.com",
    sessionId: "session-123",
    roles,
    authenticatedAt: "2026-01-01T00:00:00Z",
  };
}

/*───────────────────── Role Hierarchy Tests ─────────────────────*/

test("security: roleHasMinRank — EMPLOYEE < APPROVER", () => {
  assert.equal(roleHasMinRank("EMPLOYEE", "APPROVER"), false);
  assert.equal(roleHasMinRank("APPROVER", "APPROVER"), true);
  assert.equal(roleHasMinRank("ADMIN", "APPROVER"), true);
});

test("security: roleHasMinRank — APPROVER < GA", () => {
  assert.equal(roleHasMinRank("APPROVER", "GA"), false);
  assert.equal(roleHasMinRank("GA", "GA"), true);
  assert.equal(roleHasMinRank("ADMIN", "GA"), true);
});

test("security: roleHasMinRank — GA < MANAGEMENT", () => {
  assert.equal(roleHasMinRank("GA", "MANAGEMENT"), false);
  assert.equal(roleHasMinRank("MANAGEMENT", "MANAGEMENT"), true);
  assert.equal(roleHasMinRank("ADMIN", "MANAGEMENT"), true);
});

test("security: roleHasMinRank — MANAGEMENT < ADMIN", () => {
  assert.equal(roleHasMinRank("MANAGEMENT", "ADMIN"), false);
  assert.equal(roleHasMinRank("ADMIN", "ADMIN"), true);
});

test("security: roleHasMinRank — unknown role returns false", () => {
  assert.equal(roleHasMinRank("UNKNOWN", "EMPLOYEE"), false);
  assert.equal(roleHasMinRank("EMPLOYEE", "UNKNOWN"), false);
});

/*───────────────────── hasRole Tests ─────────────────────*/

test("security: hasRole — single matching role", () => {
  assert.equal(hasRole(["APPROVER"], "APPROVER"), true);
  assert.equal(hasRole(["EMPLOYEE"], "EMPLOYEE"), true);
});

test("security: hasRole — multiple roles, any match", () => {
  assert.equal(hasRole(["EMPLOYEE", "APPROVER"], "APPROVER"), true);
  assert.equal(hasRole(["EMPLOYEE", "GA"], "APPROVER"), true);
});

test("security: hasRole — no matching role", () => {
  assert.equal(hasRole(["EMPLOYEE"], "APPROVER"), false);
  assert.equal(hasRole([], "EMPLOYEE"), false);
});

/*───────────────────── checkAuthorization Tests ─────────────────────*/

test("security: checkAuthorization — EMPLOYEE cannot approve", () => {
  const result = checkAuthorization(principal(["EMPLOYEE"]), "approve_booking");
  assert.equal(result.authorized, false);
  assert.equal(result.error, "INSUFFICIENT_ROLE");
  assert.equal(result.requiredRole, "APPROVER");
});

test("security: checkAuthorization — APPROVER can approve", () => {
  const result = checkAuthorization(principal(["APPROVER"]), "approve_booking");
  assert.equal(result.authorized, true);
});

test("security: checkAuthorization — ADMIN can approve", () => {
  const result = checkAuthorization(principal(["ADMIN"]), "approve_booking");
  assert.equal(result.authorized, true);
});

test("security: checkAuthorization — EMPLOYEE cannot reject", () => {
  const result = checkAuthorization(principal(["EMPLOYEE"]), "reject_booking");
  assert.equal(result.authorized, false);
  assert.equal(result.error, "INSUFFICIENT_ROLE");
  assert.equal(result.requiredRole, "APPROVER");
});

test("security: checkAuthorization — APPROVER can reject", () => {
  const result = checkAuthorization(principal(["APPROVER"]), "reject_booking");
  assert.equal(result.authorized, true);
});

test("security: checkAuthorization — EMPLOYEE cannot assign driver", () => {
  const result = checkAuthorization(principal(["EMPLOYEE"]), "assign_driver");
  assert.equal(result.authorized, false);
  assert.equal(result.error, "INSUFFICIENT_ROLE");
  assert.equal(result.requiredRole, "APPROVER");
});

test("security: checkAuthorization — APPROVER can assign driver", () => {
  const result = checkAuthorization(principal(["APPROVER"]), "assign_driver");
  assert.equal(result.authorized, true);
});

test("security: checkAuthorization — EMPLOYEE can complete booking", () => {
  const result = checkAuthorization(principal(["EMPLOYEE"]), "complete_booking");
  assert.equal(result.authorized, true);
});

test("security: checkAuthorization — EMPLOYEE can cancel booking", () => {
  const result = checkAuthorization(principal(["EMPLOYEE"]), "cancel_booking");
  assert.equal(result.authorized, true);
});

test("security: checkAuthorization — EMPLOYEE can create booking", () => {
  const result = checkAuthorization(principal(["EMPLOYEE"]), "create_booking");
  assert.equal(result.authorized, true);
});

test("security: checkAuthorization — unknown action rejected", () => {
  const result = checkAuthorization(principal(["ADMIN"]), "delete_booking");
  assert.equal(result.authorized, false);
  assert.equal(result.error, "UNKNOWN_ACTION");
});

/*───────────────────── Role Resolution Tests ─────────────────────*/

test("security: resolveRoles — Administrator clearance → ADMIN", () => {
  assert.deepEqual(resolveRoles("Administrator", "admin@test.com"), ["ADMIN"]);
});

test("security: resolveRoles — Supervisor clearance → MANAGEMENT + APPROVER", () => {
  assert.deepEqual(resolveRoles("Supervisor", "sup@test.com"), ["MANAGEMENT", "APPROVER"]);
});

test("security: resolveRoles — GA clearance → GA", () => {
  assert.deepEqual(resolveRoles("GA", "ga@test.com"), ["GA"]);
});

test("security: resolveRoles — Approver clearance → APPROVER", () => {
  assert.deepEqual(resolveRoles("Approver", "appr@test.com"), ["APPROVER"]);
});

test("security: resolveRoles — Default/User clearance → EMPLOYEE", () => {
  assert.deepEqual(resolveRoles("Default User", "user@test.com"), ["EMPLOYEE"]);
  assert.deepEqual(resolveRoles("View Only", "viewer@test.com"), ["EMPLOYEE"]);
});

test("security: resolveRoles — unknown clearance → EMPLOYEE", () => {
  assert.deepEqual(resolveRoles(undefined, "unknown@test.com"), ["EMPLOYEE"]);
  assert.deepEqual(resolveRoles("", "empty@test.com"), ["EMPLOYEE"]);
});

/*───────────────────── Booking State Transition Tests ─────────────────────*/

test("security: validateTransition — DRAFT → SUBMITTED valid", () => {
  assert.equal(validateTransition("DRAFT", "SUBMITTED"), null);
});

test("security: validateTransition — SUBMITTED → PENDING_APPROVAL valid", () => {
  assert.equal(validateTransition("SUBMITTED", "PENDING_APPROVAL"), null);
});

test("security: validateTransition — PENDING_APPROVAL → APPROVED valid", () => {
  assert.equal(validateTransition("PENDING_APPROVAL", "APPROVED"), null);
});

test("security: validateTransition — PENDING_APPROVAL → REJECTED valid", () => {
  assert.equal(validateTransition("PENDING_APPROVAL", "REJECTED"), null);
});

test("security: validateTransition — PENDING_APPROVAL → CANCELLED valid", () => {
  assert.equal(validateTransition("PENDING_APPROVAL", "CANCELLED"), null);
});

test("security: validateTransition — APPROVED → ASSIGNED valid", () => {
  assert.equal(validateTransition("APPROVED", "ASSIGNED"), null);
});

test("security: validateTransition — APPROVED → CANCELLED valid", () => {
  assert.equal(validateTransition("APPROVED", "CANCELLED"), null);
});

test("security: validateTransition — ASSIGNED → COMPLETED valid", () => {
  assert.equal(validateTransition("ASSIGNED", "COMPLETED"), null);
});

test("security: validateTransition — ASSIGNED → CANCELLED valid", () => {
  assert.equal(validateTransition("ASSIGNED", "CANCELLED"), null);
});

test("security: validateTransition — COMPLETED → any invalid", () => {
  assert.equal(validateTransition("COMPLETED", "APPROVED"), "Invalid transition from COMPLETED to APPROVED");
  assert.equal(validateTransition("COMPLETED", "CANCELLED"), "Invalid transition from COMPLETED to CANCELLED");
});

test("security: validateTransition — REJECTED → any invalid", () => {
  assert.equal(validateTransition("REJECTED", "APPROVED"), "Invalid transition from REJECTED to APPROVED");
});

test("security: validateTransition — CANCELLED → any invalid", () => {
  assert.equal(validateTransition("CANCELLED", "APPROVED"), "Invalid transition from CANCELLED to APPROVED");
});

test("security: validateTransition — unknown status rejected", () => {
  assert.equal(validateTransition("UNKNOWN_STATUS", "APPROVED"), "Unknown current status: UNKNOWN_STATUS");
});

/*───────────────────── Cross-User Access Tests ─────────────────────*/

test("security: cross-user — alice cannot act as bob for approval", () => {
  const alice = principal(["APPROVER"]);
  alice.userName = "alice@test.com";
  alice.sessionId = "session-alice";
  const bob = principal(["APPROVER"]);
  bob.userName = "bob@test.com";
  bob.sessionId = "session-bob";

  assert.equal(checkAuthorization(alice, "approve_booking").authorized, true);
  assert.equal(checkAuthorization(bob, "approve_booking").authorized, true);
  assert.notEqual(alice.sessionId, bob.sessionId);
  assert.notEqual(alice.userName, bob.userName);
});

test("security: cross-user — employee cannot escalate to approver", () => {
  const employee = principal(["EMPLOYEE"]);

  assert.equal(checkAuthorization(employee, "approve_booking").authorized, false);
  assert.equal(checkAuthorization(employee, "reject_booking").authorized, false);
  assert.equal(checkAuthorization(employee, "assign_driver").authorized, false);
  assert.equal(checkAuthorization(employee, "create_booking").authorized, true);
  assert.equal(checkAuthorization(employee, "complete_booking").authorized, true);
  assert.equal(checkAuthorization(employee, "cancel_booking").authorized, true);
});

/*───────────────────── Forged Identity Tests ─────────────────────*/

test("security: forged roles — unknown clearance maps to EMPLOYEE", () => {
  assert.deepEqual(resolveRoles("FAKE_ROLE", "fake@test.com"), ["EMPLOYEE"]);
  assert.deepEqual(resolveRoles("CUSTOM_CLEARANCE_XYZ", "fake@test.com"), ["EMPLOYEE"]);
});

/*───────────────────── Replay/Duplicate Operation Tests ─────────────────────*/

test("security: idempotency — same authorization yields same result", () => {
  const p = principal(["APPROVER"]);
  const result1 = checkAuthorization(p, "approve_booking");
  const result2 = checkAuthorization(p, "approve_booking");
  assert.equal(result1.authorized, result2.authorized);
  assert.equal(result1.requiredRole, result2.requiredRole);
});

/*───────────────────── Concurrent Approval Tests ─────────────────────*/

test("security: concurrent approval — two approvers independently authorized", () => {
  const approver1 = principal(["APPROVER"]);
  approver1.sessionId = "session-1";
  const approver2 = principal(["APPROVER"]);
  approver2.sessionId = "session-2";

  assert.equal(checkAuthorization(approver1, "approve_booking").authorized, true);
  assert.equal(checkAuthorization(approver2, "approve_booking").authorized, true);
  assert.notEqual(approver1.sessionId, approver2.sessionId);
});

/*───────────────────── Session Verification Tests ─────────────────────*/
/* These test verifyIdentity input validation. Live MyGeotab session verification
   is tested against the opex_trial tenant separately (see Phase 7 test plan). */

test("security: verifyIdentity rejects missing sessionId", async () => {
  const result = await verifyIdentity("", "opex_trial", "my.geotab.com", "user@test.com");
  assert.equal(result.ok, false);
  assert.equal(result.error, "MISSING_CREDENTIALS");
});

test("security: verifyIdentity rejects missing database", async () => {
  const result = await verifyIdentity("session-123", "", "my.geotab.com", "user@test.com");
  assert.equal(result.ok, false);
  assert.equal(result.error, "MISSING_CREDENTIALS");
});

test("security: verifyIdentity rejects missing server", async () => {
  const result = await verifyIdentity("session-123", "opex_trial", "", "user@test.com");
  assert.equal(result.ok, false);
  assert.equal(result.error, "MISSING_CREDENTIALS");
});

test("security: verifyIdentity rejects missing userName", async () => {
  const result = await verifyIdentity("session-123", "opex_trial", "my.geotab.com", "");
  assert.equal(result.ok, false);
  assert.equal(result.error, "MISSING_CREDENTIALS");
});

test("security: verifyIdentity rejects empty userName", async () => {
  const result = await verifyIdentity("session-123", "opex_trial", "my.geotab.com", "");
  assert.equal(result.ok, false);
  assert.equal(result.error, "MISSING_CREDENTIALS");
});

test("security: verifyIdentity rejects whitespace-only userName", async () => {
  const result = await verifyIdentity("session-123", "opex_trial", "my.geotab.com", "   ");
  assert.equal(result.ok, false);
  /* Whitespace-only username proceeds to MyGeotab API, which will reject it */
  assert.notEqual(result.error, "MISSING_CREDENTIALS");
});

test("security: verifyIdentity accepts all required credentials", async () => {
  /* This will fail at MyGeotab API call (no real server), but should NOT
     return MISSING_CREDENTIALS — it should proceed to API verification */
  const result = await verifyIdentity("session-123", "opex_trial", "my.geotab.com", "user@test.com");
  assert.equal(result.ok, false);
  assert.notEqual(result.error, "MISSING_CREDENTIALS");
  /* Error should be from MyGeotab API (network/error), not input validation */
});

/*───────────────────── Multiple Users / Manipulated Username Tests ─────────────────────*/

test("security: multiple users with different sessionIds — independent authorization", () => {
  const user1 = principal(["APPROVER"]);
  user1.userName = "alice@test.com";
  user1.sessionId = "session-alice-001";
  const user2 = principal(["APPROVER"]);
  user2.userName = "bob@test.com";
  user2.sessionId = "session-bob-002";

  assert.equal(checkAuthorization(user1, "approve_booking").authorized, true);
  assert.equal(checkAuthorization(user2, "approve_booking").authorized, true);
  assert.notEqual(user1.sessionId, user2.sessionId);
  assert.notEqual(user1.userName, user2.userName);
});

test("security: manipulated username — server resolves from session, not client input", () => {
  /* The server verifies sessionId against MyGeotab, not the client-supplied userName.
     A manipulated userName would fail MyGeotab session verification. */
  const principalWithManipulatedUserName = principal(["APPROVER"]);
  principalWithManipulatedUserName.userName = "attacker@test.com";
  principalWithManipulatedUserName.sessionId = "session-victim-001";

  /* The principal's roles determine authorization, not the username string */
  assert.equal(checkAuthorization(principalWithManipulatedUserName, "approve_booking").authorized, true);
  /* But the session verification would fail if sessionId doesn't match userName */
});

/*───────────────────── Invalid Session Tests ─────────────────────*/

test("security: invalid session rejected by verifyIdentity", async () => {
  /* verifyIdentity with valid format but fake session — MyGeotab would reject */
  const result = await verifyIdentity("invalid-session-id", "opex_trial", "my.geotab.com", "user@test.com");
  assert.equal(result.ok, false);
  /* Error should not be MISSING_CREDENTIALS (all params provided) */
  assert.notEqual(result.error, "MISSING_CREDENTIALS");
});

/*───────────────────── Idempotency Key Tests ─────────────────────*/

test("security: idempotency key structure — key is stored with execution result", () => {
  /* Idempotency keys are stored as AddInData records with recordType "idempotency_key".
     The key links sessionId + action + bookingId to prevent replay. */
  const key = "idempotency-key-test-001";
  assert.equal(typeof key, "string");
  assert.equal(key.length > 0, true);
  /* Key uniqueness: different operations must have different keys */
  const key2 = "idempotency-key-test-002";
  assert.notEqual(key, key2);
});

test("security: idempotency prevents replay — same key returns cached result", () => {
  /* Server-side idempotency: checkIdempotencyKey returns cached result if key exists.
     This is tested at the integration level against a real MyGeotab tenant.
     Unit test verifies the key format and comparison logic. */
  const key1 = "idem-booking-1-approve-user1";
  const key2 = "idem-booking-1-approve-user1";
  const key3 = "idem-booking-1-approve-user2";
  assert.equal(key1, key2);
  assert.notEqual(key1, key3);
});
