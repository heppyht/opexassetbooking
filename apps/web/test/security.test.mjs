/*───────────────────── Security Tests ─────────────────────*/
/* Automated unit tests for RBAC and authorization controls.
   These test client-side authorization logic only.
   Live MyGeotab security validation must be performed separately
   against the opex_trial tenant (see Phase 5 test plan). */

import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeAction,
  canPerformAction,
  isAuthorizedActor,
} from "../src/auth/authorization.ts";
import { emitAuditEvent, resetAuditDedupForTests, resetAuditQueueForTests } from "../src/audit/auditTrail.ts";
import { canPerformLiveWrite } from "../src/auth/identityResolver.ts";

/*───────────────────── Local Type Definitions ─────────────────────*/
/* Duplicated from src/auth/identityResolver.ts to avoid import type syntax
   which is not supported in .mjs test files without --experimental-strip-types. */

/** @type {import("../src/auth/identityResolver").IdentityResolutionState} */

/*───────────────────── Test Helpers ─────────────────────*/

function authenticatedIdentity(roles) {
  return {
    status: "authenticated",
    principal: { id: "user-123", name: "Test User", roles, session: { userName: "testuser" } },
    session: { userName: "testuser" },
  };
}

function unresolvedIdentity() {
  return {
    status: "unresolved",
    session: { userName: "testuser" },
    reason: "Identity could not be verified.",
  };
}

function errorIdentity() {
  return {
    status: "error",
    session: { userName: "testuser" },
    reason: "API error.",
  };
}

function loadingIdentity() {
  return {
    status: "loading",
    session: { userName: "testuser" },
  };
}

function mockProvider() {
  return {
    createAuditRecord: async () => {},
  };
}

/*───────────────────── Authorization Module Tests ─────────────────────*/

test("security: authorizeAction rejects null identity", async () => {
  const result = authorizeAction("approve_booking", null);
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "IDENTITY_NOT_RESOLVED");
});

test("security: authorizeAction rejects unresolved identity", async () => {
  const result = authorizeAction("approve_booking", unresolvedIdentity());
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "IDENTITY_UNRESOLVED");
});

test("security: authorizeAction rejects error identity", async () => {
  const result = authorizeAction("approve_booking", errorIdentity());
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "IDENTITY_ERROR");
});

test("security: authorizeAction rejects loading identity (fail-closed)", async () => {
  const result = authorizeAction("approve_booking", loadingIdentity());
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "IDENTITY_LOADING");
});

test("security: authorizeAction requires APPROVER role for approve_booking", async () => {
  const identity = authenticatedIdentity(["EMPLOYEE"]);
  const result = authorizeAction("approve_booking", identity);
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "INSUFFICIENT_ROLE");
  assert.equal(result.requiredRole, "APPROVER");
});

test("security: authorizeAction allows APPROVER role for approve_booking", async () => {
  const identity = authenticatedIdentity(["APPROVER"]);
  const result = authorizeAction("approve_booking", identity);
  assert.equal(result.authorized, true);
});

test("security: authorizeAction allows ADMIN role for approve_booking", async () => {
  const identity = authenticatedIdentity(["ADMIN"]);
  const result = authorizeAction("approve_booking", identity);
  assert.equal(result.authorized, true);
});

test("security: authorizeAction allows MANAGEMENT role for approve_booking", async () => {
  const identity = authenticatedIdentity(["MANAGEMENT"]);
  const result = authorizeAction("approve_booking", identity);
  assert.equal(result.authorized, true);
});

test("security: authorizeAction allows GA role for approve_booking", async () => {
  const identity = authenticatedIdentity(["GA"]);
  const result = authorizeAction("approve_booking", identity);
  assert.equal(result.authorized, true);
});

test("security: authorizeAction requires APPROVER role for reject_booking", async () => {
  const identity = authenticatedIdentity(["EMPLOYEE"]);
  const result = authorizeAction("reject_booking", identity);
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "INSUFFICIENT_ROLE");
  assert.equal(result.requiredRole, "APPROVER");
});

test("security: authorizeAction allows APPROVER role for reject_booking", async () => {
  const identity = authenticatedIdentity(["APPROVER"]);
  const result = authorizeAction("reject_booking", identity);
  assert.equal(result.authorized, true);
});

test("security: authorizeAction requires APPROVER role for assign_driver", async () => {
  const identity = authenticatedIdentity(["EMPLOYEE"]);
  const result = authorizeAction("assign_driver", identity);
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "INSUFFICIENT_ROLE");
  assert.equal(result.requiredRole, "APPROVER");
});

test("security: authorizeAction allows APPROVER role for assign_driver", async () => {
  const identity = authenticatedIdentity(["APPROVER"]);
  const result = authorizeAction("assign_driver", identity);
  assert.equal(result.authorized, true);
});

test("security: authorizeAction allows EMPLOYEE role for create_booking", async () => {
  const identity = authenticatedIdentity(["EMPLOYEE"]);
  const result = authorizeAction("create_booking", identity);
  assert.equal(result.authorized, true);
});

test("security: authorizeAction allows EMPLOYEE role for complete_booking", async () => {
  const identity = authenticatedIdentity(["EMPLOYEE"]);
  const result = authorizeAction("complete_booking", identity);
  assert.equal(result.authorized, true);
});

test("security: authorizeAction allows EMPLOYEE role for cancel_booking", async () => {
  const identity = authenticatedIdentity(["EMPLOYEE"]);
  const result = authorizeAction("cancel_booking", identity);
  assert.equal(result.authorized, true);
});

test("security: authorizeAction denies unknown role", async () => {
  const identity = authenticatedIdentity(["UNKNOWN_ROLE"]);
  const result = authorizeAction("approve_booking", identity);
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "INSUFFICIENT_ROLE");
});

test("security: authorizeAction denies empty roles array", async () => {
  const identity = authenticatedIdentity([]);
  const result = authorizeAction("approve_booking", identity);
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "INSUFFICIENT_ROLE");
});

/*───────────────────── canPerformAction Tests ─────────────────────*/

test("security: canPerformAction returns false for null identity", () => {
  assert.equal(canPerformAction("approve_booking", null), false);
});

test("security: canPerformAction returns false for unresolved identity", () => {
  assert.equal(canPerformAction("approve_booking", unresolvedIdentity()), false);
});

test("security: canPerformAction returns true for APPROVER approving", () => {
  assert.equal(canPerformAction("approve_booking", authenticatedIdentity(["APPROVER"])), true);
});

test("security: canPerformAction returns false for EMPLOYEE approving", () => {
  assert.equal(canPerformAction("approve_booking", authenticatedIdentity(["EMPLOYEE"])), false);
});

/*───────────────────── isAuthorizedActor Tests ─────────────────────*/

test("security: isAuthorizedActor rejects null actorUserId", () => {
  assert.equal(isAuthorizedActor(null, authenticatedIdentity(["APPROVER"])), false);
});

test("security: isAuthorizedActor rejects undefined actorUserId", () => {
  assert.equal(isAuthorizedActor(undefined, authenticatedIdentity(["APPROVER"])), false);
});

test("security: isAuthorizedActor rejects empty actorUserId", () => {
  assert.equal(isAuthorizedActor("", authenticatedIdentity(["APPROVER"])), false);
});

test("security: isAuthorizedActor rejects null identity", () => {
  assert.equal(isAuthorizedActor("user-123", null), false);
});

test("security: isAuthorizedActor rejects unresolved identity", () => {
  assert.equal(isAuthorizedActor("user-123", unresolvedIdentity()), false);
});

test("security: isAuthorizedActor rejects mismatched actorUserId", () => {
  assert.equal(isAuthorizedActor("user-456", authenticatedIdentity(["APPROVER"])), false);
});

test("security: isAuthorizedActor accepts matching actorUserId", () => {
  assert.equal(isAuthorizedActor("user-123", authenticatedIdentity(["APPROVER"])), true);
});

test("security: isAuthorizedActor accepts matching actorUserId with whitespace", () => {
  assert.equal(isAuthorizedActor("  user-123  ", authenticatedIdentity(["APPROVER"])), true);
});

/*───────────────────── Audit Actor Validation Tests ─────────────────────*/

test("security: emitAuditEvent rejects actorUserId mismatch with authenticated identity", async () => {
  resetAuditDedupForTests();
  resetAuditQueueForTests();
  const identity = authenticatedIdentity(["APPROVER"]);
  const result = await emitAuditEvent({
    mode: "ADDIN_DATA",
    provider: mockProvider(),
    entityId: "booking-1",
    action: "BOOKING_APPROVED",
    actorUserId: "different-user",
    identity,
    previousStatus: "PENDING_APPROVAL",
    newStatus: "APPROVED",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "AUDIT_ACTOR_MISMATCH");
});

test("security: emitAuditEvent accepts matching actorUserId with authenticated identity", async () => {
  resetAuditDedupForTests();
  resetAuditQueueForTests();
  const identity = authenticatedIdentity(["APPROVER"]);
  const result = await emitAuditEvent({
    mode: "ADDIN_DATA",
    provider: mockProvider(),
    entityId: "booking-1",
    action: "BOOKING_APPROVED",
    actorUserId: "user-123",
    identity,
    previousStatus: "PENDING_APPROVAL",
    newStatus: "APPROVED",
  });
  assert.equal(result.ok, true);
});

test("security: emitAuditEvent allows actorUserId when identity is null (backward compat)", async () => {
  resetAuditDedupForTests();
  resetAuditQueueForTests();
  const result = await emitAuditEvent({
    mode: "ADDIN_DATA",
    provider: mockProvider(),
    entityId: "booking-1",
    action: "BOOKING_APPROVED",
    actorUserId: "any-user",
    identity: null,
    previousStatus: "PENDING_APPROVAL",
    newStatus: "APPROVED",
  });
  assert.equal(result.ok, true);
});

test("security: emitAuditEvent allows actorUserId when identity is unresolved", async () => {
  resetAuditDedupForTests();
  resetAuditQueueForTests();
  const result = await emitAuditEvent({
    mode: "ADDIN_DATA",
    provider: mockProvider(),
    entityId: "booking-1",
    action: "BOOKING_APPROVED",
    actorUserId: "any-user",
    identity: unresolvedIdentity(),
    previousStatus: "PENDING_APPROVAL",
    newStatus: "APPROVED",
  });
  assert.equal(result.ok, true);
});

/*───────────────────── canPerformLiveWrite Fail-Closed Tests ─────────────────────*/

test("security: canPerformLiveWrite returns true for DEMO mode regardless of identity", () => {
  assert.equal(canPerformLiveWrite("DEMO", null), true);
  assert.equal(canPerformLiveWrite("DEMO", unresolvedIdentity()), true);
});

test("security: canPerformLiveWrite returns false for ADDIN_DATA with null identity", () => {
  assert.equal(canPerformLiveWrite("ADDIN_DATA", null), false);
});

test("security: canPerformLiveWrite returns false for ADDIN_DATA with unresolved identity", () => {
  assert.equal(canPerformLiveWrite("ADDIN_DATA", unresolvedIdentity()), false);
});

test("security: canPerformLiveWrite returns false for ADDIN_DATA with loading identity", () => {
  assert.equal(canPerformLiveWrite("ADDIN_DATA", loadingIdentity()), false);
});

test("security: canPerformLiveWrite returns true for ADDIN_DATA with authenticated identity", () => {
  assert.equal(canPerformLiveWrite("ADDIN_DATA", authenticatedIdentity(["EMPLOYEE"])), true);
});

/*───────────────────── Cross-User Access Tests ─────────────────────*/

test("security: cross-user actor mismatch is rejected", () => {
  const identityA = authenticatedIdentity(["APPROVER"]);
  identityA.principal.id = "user-alice";
  const identityB = authenticatedIdentity(["APPROVER"]);
  identityB.principal.id = "user-bob";
  // Alice cannot act as Bob
  assert.equal(isAuthorizedActor("user-bob", identityA), false);
  // Bob cannot act as Alice
  assert.equal(isAuthorizedActor("user-alice", identityB), false);
});

test("security: cross-user authorizeAction uses correct principal", () => {
  const identityA = authenticatedIdentity(["APPROVER"]);
  identityA.principal.id = "user-alice";
  const result = authorizeAction("approve_booking", identityA);
  assert.equal(result.authorized, true);
  // The principal is alice, so only alice's audit events would be valid
  assert.equal(isAuthorizedActor("user-alice", identityA), true);
  assert.equal(isAuthorizedActor("user-bob", identityA), false);
});
