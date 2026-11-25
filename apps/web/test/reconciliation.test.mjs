/*───────────────────── Reconciliation Engine Tests ─────────────────────*/
/* Automated unit tests for Phase 18 audit reconciliation engine.
   Tests evidence classification, severity assignment, finding generation,
   and the full reconcileAuditEnhanced engine. These are UNIT tests
   with mock data — no live MyGeotab access. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcileAuditEnhanced,
  classifyEvidence,
  findingSeverity,
  toOpexReconciliationFinding,
} from "../src/audit/auditTrail.ts";
import {
  validateBookingState,
  validateBookingTransition,
  isValidBookingStatus,
  getValidTransitions,
} from "../../../apps/api/src/authz.ts";

/*───────────────────── Test Data Helpers ─────────────────────*/

function booking(id, status, version = 1) {
  return { id, status, version, requester_id: "user-1" };
}

function audit(bookingId, action, actorUserId = "user-1", newStatus = null, previousStatus = null, opts = {}) {
  const sourceFormat = opts.sourceFormat === "canonical" ? "canonical" : "legacy";
  return {
    id: `audit-${bookingId}-${action}`,
    recordType: sourceFormat === "canonical" ? "bookingAudit" : "booking_audit",
    schemaVersion: 1,
    auditKey: opts.auditKey ?? (sourceFormat === "canonical" ? `audit-key-${bookingId}-${action}` : undefined),
    bookingKey: bookingId,
    action,
    actor: { userId: actorUserId },
    occurredAtUtc: "2026-01-01T00:00:00Z",
    previousStatus,
    newStatus,
    changes: null,
    metadata: null,
    sourceFormat,
  };
}

function notification(bookingId, actorUserId = "user-1") {
  return {
    id: `notif-${bookingId}`,
    booking_id: bookingId,
    actor_user_id: actorUserId,
    created_at: "2026-01-01T00:00:00Z",
    type: "info",
  };
}

/*───────────────────── classifyEvidence Tests ─────────────────────*/

test("reconciliation: classifyEvidence returns LEGITIMATE_PARTIAL_WRITE for missing audit with valid actor/transition/prior", () => {
  const result = classifyEvidence("MISSING_AUDIT_EVENT", true, true, true);
  assert.equal(result, "LEGITIMATE_PARTIAL_WRITE");
});

test("reconciliation: classifyEvidence returns INTERRUPTED_OPERATION for missing audit with no prior trail", () => {
  const result = classifyEvidence("MISSING_AUDIT_EVENT", true, true, false);
  assert.equal(result, "INTERRUPTED_OPERATION");
});

test("reconciliation: classifyEvidence returns POTENTIAL_UNAUTHORIZED_WRITE for invalid actor", () => {
  const result = classifyEvidence("MISSING_AUDIT_EVENT", false, true, true);
  assert.equal(result, "POTENTIAL_UNAUTHORIZED_WRITE");
});

test("reconciliation: classifyEvidence returns POTENTIAL_UNAUTHORIZED_WRITE for invalid transition", () => {
  const result = classifyEvidence("UNEXPECTED_STATUS_TRANSITION", true, false, true);
  assert.equal(result, "POTENTIAL_UNAUTHORIZED_WRITE");
});

test("reconciliation: classifyEvidence returns INSUFFICIENT_EVIDENCE when nothing is known", () => {
  const result = classifyEvidence("INSUFFICIENT_EVIDENCE", false, false, false);
  assert.equal(result, "INSUFFICIENT_EVIDENCE");
});

/*───────────────────── findingSeverity Tests ─────────────────────*/

test("reconciliation: findingSeverity returns HIGH for INVALID_ACTOR_ATTRIBUTION", () => {
  assert.equal(findingSeverity("INVALID_ACTOR_ATTRIBUTION"), "HIGH");
});

test("reconciliation: findingSeverity returns HIGH for RECORD_MODIFIED_WITHOUT_AUDIT", () => {
  assert.equal(findingSeverity("RECORD_MODIFIED_WITHOUT_AUDIT"), "HIGH");
});

test("reconciliation: findingSeverity returns HIGH for DUPLICATE_BOOKING_RECORD", () => {
  assert.equal(findingSeverity("DUPLICATE_BOOKING_RECORD"), "HIGH");
});

test("reconciliation: findingSeverity returns HIGH for UNEXPECTED_STATUS_TRANSITION", () => {
  assert.equal(findingSeverity("UNEXPECTED_STATUS_TRANSITION"), "HIGH");
});

test("reconciliation: findingSeverity returns MEDIUM for MISSING_AUDIT_EVENT", () => {
  assert.equal(findingSeverity("MISSING_AUDIT_EVENT"), "MEDIUM");
});

test("reconciliation: findingSeverity returns LOW for INSUFFICIENT_EVIDENCE", () => {
  assert.equal(findingSeverity("INSUFFICIENT_EVIDENCE"), "LOW");
});

/*───────────────────── reconcileAuditEnhanced Tests ─────────────────────*/

test("reconciliation: detect missing audit event for APPROVED booking without approval audit", () => {
  const bookings = [booking("b1", "APPROVED")];
  const audits = [audit("b1", "BOOKING_CREATED")];
  const notifications = [];
  const findings = reconcileAuditEnhanced(bookings, audits, notifications);
  const missing = findings.find(f => f.finding_type === "MISSING_AUDIT_EVENT" && f.booking_id === "b1");
  assert.ok(missing, "Expected MISSING_AUDIT_EVENT finding");
  assert.equal(missing.severity, "MEDIUM");
  assert.ok(missing.notes.includes("BOOKING_APPROVED"));
});

test("reconciliation: no findings when audit trail is complete", () => {
  const bookings = [booking("b1", "APPROVED")];
  const audits = [
    audit("b1", "BOOKING_CREATED"),
    audit("b1", "BOOKING_APPROVED"),
  ];
  const notifications = [];
  const findings = reconcileAuditEnhanced(bookings, audits, notifications);
  const missing = findings.find(f => f.booking_id === "b1" && f.finding_type === "MISSING_AUDIT_EVENT");
  assert.equal(missing, undefined);
});

test("reconciliation: detect invalid actor attribution", () => {
  const bookings = [booking("b1", "APPROVED")];
  const audits = [
    audit("b1", "BOOKING_CREATED", "user-1"),
    audit("b1", "BOOKING_CANCELLED", "different-user"),
  ];
  const notifications = [];
  const findings = reconcileAuditEnhanced(bookings, audits, notifications);
  const invalidActor = findings.find(f => f.finding_type === "INVALID_ACTOR_ATTRIBUTION");
  assert.ok(invalidActor, "Expected INVALID_ACTOR_ATTRIBUTION finding");
  assert.equal(invalidActor.severity, "HIGH");
});

test("reconciliation: allow approver acting on behalf for approval actions", () => {
  const bookings = [booking("b1", "APPROVED")];
  const audits = [
    audit("b1", "BOOKING_CREATED", "user-1"),
    audit("b1", "BOOKING_APPROVED", "approver-user"),
  ];
  const notifications = [];
  const findings = reconcileAuditEnhanced(bookings, audits, notifications);
  const invalidActor = findings.find(f => f.finding_type === "INVALID_ACTOR_ATTRIBUTION");
  assert.equal(invalidActor, undefined);
});

test("reconciliation: detect duplicate booking records", () => {
  const bookings = [
    booking("b1", "DRAFT"),
    booking("b1", "DRAFT"),
  ];
  const audits = [];
  const notifications = [];
  const findings = reconcileAuditEnhanced(bookings, audits, notifications);
  const dup = findings.find(f => f.finding_type === "DUPLICATE_BOOKING_RECORD");
  assert.ok(dup, "Expected DUPLICATE_BOOKING_RECORD finding");
  assert.equal(dup.severity, "HIGH");
});

test("reconciliation: detect orphaned audit record (no booking)", () => {
  const bookings = [booking("b1", "DRAFT")];
  const audits = [audit("b2", "BOOKING_CREATED", "user-1")];
  const notifications = [];
  const findings = reconcileAuditEnhanced(bookings, audits, notifications);
  const orphaned = findings.find(f => f.finding_type === "RECORD_DELETED_WITHOUT_AUDIT");
  assert.ok(orphaned, "Expected RECORD_DELETED_WITHOUT_AUDIT finding");
  assert.equal(orphaned.booking_id, "b2");
});

test("reconciliation: detect notification referencing non-existent booking", () => {
  const bookings = [booking("b1", "DRAFT")];
  const audits = [];
  const notifications = [notification("b2")];
  const findings = reconcileAuditEnhanced(bookings, audits, notifications);
  const manipulated = findings.find(f => f.finding_type === "NOTIFICATION_MANIPULATION");
  assert.ok(manipulated, "Expected NOTIFICATION_MANIPULATION finding");
});

test("reconciliation: detect inconsistent state — APPROVED without BOOKING_APPROVED", () => {
  const bookings = [booking("b1", "APPROVED")];
  const audits = [audit("b1", "BOOKING_CREATED")];
  const notifications = [];
  const findings = reconcileAuditEnhanced(bookings, audits, notifications);
  const inconsistent = findings.find(f => f.finding_type === "INCONSISTENT_BOOKING_STATE");
  assert.ok(inconsistent, "Expected INCONSISTENT_BOOKING_STATE finding");
});

test("reconciliation: empty inputs produce no findings", () => {
  const findings = reconcileAuditEnhanced([], [], []);
  assert.equal(findings.length, 0);
});

test("reconciliation: finding has all required fields", () => {
  const bookings = [booking("b1", "APPROVED")];
  const audits = [audit("b1", "BOOKING_CREATED")];
  const notifications = [];
  const findings = reconcileAuditEnhanced(bookings, audits, notifications);
  assert.ok(findings.length > 0);
  const f = findings[0];
  assert.ok(f.finding_id);
  assert.ok(f.booking_id);
  assert.ok(f.finding_type);
  assert.ok(f.severity);
  assert.ok(f.detection_timestamp);
  assert.ok(Array.isArray(f.related_audit_references));
  assert.equal(f.reconciliation_status, "OPEN");
  assert.ok(f.notes);
});

/*───────────────────── Dual-format audit reconciliation tests ─────────────────────*/

test("reconciliation: canonical bookingAudit records are normalized and reconciled", () => {
  const bookings = [booking("b1", "APPROVED")];
  const audits = [
    audit("b1", "BOOKING_CREATED", "user-1", "PENDING_APPROVAL", null, { sourceFormat: "canonical" }),
    audit("b1", "BOOKING_APPROVED", "approver-user", "APPROVED", "PENDING_APPROVAL", { sourceFormat: "canonical" }),
  ];
  const findings = reconcileAuditEnhanced(bookings, audits, []);
  const missing = findings.find(f => f.booking_id === "b1" && f.finding_type === "MISSING_AUDIT_EVENT");
  assert.equal(missing, undefined, "Canonical audits should satisfy expected audit actions");
  const dup = findings.find(f => f.finding_type === "DUPLICATE_AUDIT_EVENT");
  assert.equal(dup, undefined, "Distinct canonical auditKeys should not be flagged as duplicates");
});

test("reconciliation: legacy booking_audit records are normalized and reconciled", () => {
  const bookings = [booking("b1", "APPROVED")];
  const audits = [
    audit("b1", "BOOKING_CREATED", "user-1", "PENDING_APPROVAL", null, { sourceFormat: "legacy" }),
    audit("b1", "BOOKING_APPROVED", "approver-user", "APPROVED", "PENDING_APPROVAL", { sourceFormat: "legacy" }),
  ];
  const findings = reconcileAuditEnhanced(bookings, audits, []);
  const missing = findings.find(f => f.booking_id === "b1" && f.finding_type === "MISSING_AUDIT_EVENT");
  assert.equal(missing, undefined, "Legacy audits should satisfy expected audit actions");
});

test("reconciliation: mixed legacy and canonical audit records are reconciled together", () => {
  const bookings = [booking("b1", "APPROVED")];
  const audits = [
    audit("b1", "BOOKING_CREATED", "user-1", "PENDING_APPROVAL", null, { sourceFormat: "legacy" }),
    audit("b1", "BOOKING_APPROVED", "approver-user", "APPROVED", "PENDING_APPROVAL", { sourceFormat: "canonical" }),
  ];
  const findings = reconcileAuditEnhanced(bookings, audits, []);
  const missing = findings.find(f => f.booking_id === "b1" && f.finding_type === "MISSING_AUDIT_EVENT");
  assert.equal(missing, undefined, "Mixed formats should together satisfy expected audit actions");
});

test("reconciliation: duplicate canonical audit events are detected by auditKey", () => {
  const bookings = [booking("b1", "PENDING_APPROVAL")];
  const audits = [
    audit("b1", "BOOKING_CREATED", "user-1", "PENDING_APPROVAL", null, { sourceFormat: "canonical", auditKey: "shared-key" }),
    audit("b1", "BOOKING_CREATED", "user-1", "PENDING_APPROVAL", null, { sourceFormat: "canonical", auditKey: "shared-key" }),
  ];
  const findings = reconcileAuditEnhanced(bookings, audits, []);
  const dup = findings.find(f => f.finding_type === "DUPLICATE_AUDIT_EVENT");
  assert.ok(dup, "Expected DUPLICATE_AUDIT_EVENT finding for shared auditKey");
  assert.equal(dup.severity, "HIGH");
  assert.ok(dup.notes.includes("shared-key"));
});

test("reconciliation: legacy records without auditKey are not flagged as duplicates", () => {
  const bookings = [booking("b1", "PENDING_APPROVAL")];
  const audits = [
    audit("b1", "BOOKING_CREATED", "user-1", "PENDING_APPROVAL", null, { sourceFormat: "legacy" }),
    audit("b1", "BOOKING_CREATED", "user-1", "PENDING_APPROVAL", null, { sourceFormat: "legacy" }),
  ];
  const findings = reconcileAuditEnhanced(bookings, audits, []);
  const dup = findings.find(f => f.finding_type === "DUPLICATE_AUDIT_EVENT");
  assert.equal(dup, undefined, "Legacy records have no auditKey and should not be duplicate-flagged");
});

test("reconciliation: canonical records with distinct auditKeys are not duplicates", () => {
  const bookings = [booking("b1", "PENDING_APPROVAL")];
  const audits = [
    audit("b1", "BOOKING_CREATED", "user-1", "PENDING_APPROVAL", null, { sourceFormat: "canonical", auditKey: "key-a" }),
    audit("b1", "BOOKING_CREATED", "user-1", "PENDING_APPROVAL", null, { sourceFormat: "canonical", auditKey: "key-b" }),
  ];
  const findings = reconcileAuditEnhanced(bookings, audits, []);
  const dup = findings.find(f => f.finding_type === "DUPLICATE_AUDIT_EVENT");
  assert.equal(dup, undefined, "Distinct canonical auditKeys should not be flagged");
});

test("reconciliation: malformed audit records do not crash reconciliation", () => {
  /* APPROVED booking expects BOOKING_APPROVED; supply only CREATED plus a null
     and an unknown-typed record. Reconciliation must not crash on malformed
     records and should still evaluate the well-formed audit. */
  const bookings = [booking("b1", "APPROVED")];
  const audits = [
    audit("b1", "BOOKING_CREATED", "user-1", "PENDING_APPROVAL", null, { sourceFormat: "legacy" }),
    null,
    { recordType: "unknown_type", details: "garbage" },
  ];
  const findings = reconcileAuditEnhanced(bookings, audits, []);
  assert.ok(Array.isArray(findings), "Should return findings array");
  const missing = findings.find(f => f.booking_id === "b1" && f.finding_type === "MISSING_AUDIT_EVENT");
  assert.ok(missing, "APPROVED booking should still be evaluated for missing audit events");
  assert.ok(missing.notes.includes("BOOKING_APPROVED"));
});

test("reconciliation: missing audit event detected for canonical audit only", () => {
  const bookings = [booking("b1", "APPROVED")];
  const audits = [audit("b1", "BOOKING_CREATED", "user-1", "PENDING_APPROVAL", null, { sourceFormat: "canonical" })];
  const findings = reconcileAuditEnhanced(bookings, audits, []);
  const missing = findings.find(f => f.booking_id === "b1" && f.finding_type === "MISSING_AUDIT_EVENT");
  assert.ok(missing, "Expected MISSING_AUDIT_EVENT for missing BOOKING_APPROVED");
  assert.ok(missing.notes.includes("BOOKING_APPROVED"));
});

/*───────────────────── toOpexReconciliationFinding Tests ─────────────────────*/

test("reconciliation: toOpexReconciliationFinding produces valid storage record", () => {
  const finding = {
    finding_id: "find-1",
    booking_id: "b1",
    finding_type: "MISSING_AUDIT_EVENT",
    severity: "MEDIUM",
    expected_state: "Expected BOOKING_APPROVED",
    observed_state: "Only BOOKING_CREATED present",
    detection_timestamp: "2026-01-01T00:00:00Z",
    related_audit_references: ["audit-1"],
    reconciliation_status: "OPEN",
    evidence_classification: "LEGITIMATE_PARTIAL_WRITE",
    notes: "Test finding",
  };
  const storage = toOpexReconciliationFinding(finding);
  assert.equal(storage.recordType, "reconciliation_finding");
  assert.equal(storage.schemaVersion, 1);
  assert.equal(storage.id, "find-1");
  assert.equal(storage.finding_id, "find-1");
  assert.equal(storage.booking_id, "b1");
  assert.equal(storage.finding_type, "MISSING_AUDIT_EVENT");
  assert.equal(storage.severity, "MEDIUM");
  assert.equal(storage.reconciliation_status, "OPEN");
  assert.equal(storage.evidence_classification, "LEGITIMATE_PARTIAL_WRITE");
});

/*───────────────────── validateBookingState Tests ─────────────────────*/

test("reconciliation: validateBookingState accepts valid APPROVED booking with complete audits", () => {
  const result = validateBookingState(
    { id: "b1", status: "APPROVED", version: 2 },
    ["BOOKING_CREATED", "BOOKING_APPROVED"],
  );
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("reconciliation: validateBookingState rejects unknown status", () => {
  const result = validateBookingState(
    { id: "b1", status: "INVALID_STATUS", version: 1 },
    [],
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("Unknown booking status")));
});

test("reconciliation: validateBookingState detects missing required audit action", () => {
  const result = validateBookingState(
    { id: "b1", status: "APPROVED", version: 2 },
    ["BOOKING_CREATED"],
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("BOOKING_APPROVED")));
});

test("reconciliation: validateBookingState rejects invalid version", () => {
  const result = validateBookingState(
    { id: "b1", status: "DRAFT", version: 0 },
    ["BOOKING_CREATED"],
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("version")));
});

test("reconciliation: validateBookingState warns when version < audit count", () => {
  const result = validateBookingState(
    { id: "b1", status: "APPROVED", version: 1 },
    ["BOOKING_CREATED", "BOOKING_APPROVED"],
  );
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some(w => w.includes("lower than")));
});

/*───────────────────── validateBookingTransition Tests ─────────────────────*/

test("reconciliation: validateBookingTransition allows DRAFT -> SUBMITTED", () => {
  const result = validateBookingTransition("DRAFT", "SUBMITTED");
  assert.equal(result.allowed, true);
  assert.equal(result.error, null);
});

test("reconciliation: validateBookingTransition denies DRAFT -> APPROVED", () => {
  const result = validateBookingTransition("DRAFT", "APPROVED");
  assert.equal(result.allowed, false);
  assert.ok(result.error.includes("Invalid transition"));
});

test("reconciliation: validateBookingTransition denies unknown current status", () => {
  const result = validateBookingTransition("UNKNOWN", "DRAFT");
  assert.equal(result.allowed, false);
  assert.ok(result.error.includes("Unknown current status"));
});

test("reconciliation: validateBookingTransition allows PENDING_APPROVAL -> REJECTED", () => {
  const result = validateBookingTransition("PENDING_APPROVAL", "REJECTED");
  assert.equal(result.allowed, true);
});

test("reconciliation: validateBookingTransition denies COMPLETED -> any", () => {
  const result = validateBookingTransition("COMPLETED", "DRAFT");
  assert.equal(result.allowed, false);
});

/*───────────────────── isValidBookingStatus Tests ─────────────────────*/

test("reconciliation: isValidBookingStatus accepts known statuses", () => {
  for (const s of ["DRAFT", "SUBMITTED", "PENDING_APPROVAL", "APPROVED", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "REJECTED", "CANCELLED"]) {
    assert.equal(isValidBookingStatus(s), true);
  }
});

test("reconciliation: isValidBookingStatus rejects unknown statuses", () => {
  assert.equal(isValidBookingStatus(""), false);
  assert.equal(isValidBookingStatus("UNKNOWN"), false);
  assert.equal(isValidBookingStatus("approved"), false);
});

/*───────────────────── getValidTransitions Tests ─────────────────────*/

test("reconciliation: getValidTransitions returns allowed transitions for PENDING_APPROVAL", () => {
  const transitions = getValidTransitions("PENDING_APPROVAL");
  assert.ok(transitions.includes("APPROVED"));
  assert.ok(transitions.includes("REJECTED"));
  assert.ok(transitions.includes("CANCELLED"));
  assert.equal(transitions.length, 3);
});

test("reconciliation: getValidTransitions returns empty for COMPLETED", () => {
  const transitions = getValidTransitions("COMPLETED");
  assert.equal(transitions.length, 0);
});

test("reconciliation: getValidTransitions returns empty for unknown status", () => {
  const transitions = getValidTransitions("UNKNOWN");
  assert.equal(transitions.length, 0);
});
