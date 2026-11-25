import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAuditRecord as normalizeShared,
  isCanonicalAudit as isCanonicalShared,
} from "../src/data/types.ts";
import {
  normalizeAuditRecord as normalizeServiceAddIn,
  isCanonicalAudit as isCanonicalServiceAddIn,
} from "../src/serviceAddin.ts";

function canonicalRecord(overrides = {}) {
  return {
    recordType: "bookingAudit",
    schemaVersion: 1,
    auditKey: "audit-key-1",
    bookingKey: "booking-1",
    action: "BOOKING_APPROVED",
    actor: { userId: "user-1", userName: "approver@example.com", role: "APPROVER" },
    occurredAtUtc: "2026-11-18T10:22:55.945Z",
    previousStatus: "PENDING_APPROVAL",
    newStatus: "APPROVED",
    changes: { status: { from: "PENDING_APPROVAL", to: "APPROVED" } },
    metadata: { source: "OPEX_VBM", mode: "ADDIN_DATA" },
    ...overrides,
  };
}

function legacyRecord(overrides = {}) {
  return {
    recordType: "booking_audit",
    schemaVersion: 1,
    id: "legacy-audit-1",
    booking_id: "booking-1",
    action: "BOOKING_APPROVED",
    actor_user_id: "user-1",
    previous_status: "PENDING_APPROVAL",
    new_status: "APPROVED",
    details: null,
    created_at: "2026-11-18T10:22:55.945Z",
    ...overrides,
  };
}

test("S-03: isCanonicalAudit returns true for bookingAudit (both implementations)", () => {
  const rec = canonicalRecord();
  assert.equal(isCanonicalShared(rec), true);
  assert.equal(isCanonicalServiceAddIn(rec), true);
});

test("S-03: isCanonicalAudit returns false for booking_audit (both implementations)", () => {
  const rec = legacyRecord();
  assert.equal(isCanonicalShared(rec), false);
  assert.equal(isCanonicalServiceAddIn(rec), false);
});

test("S-03: isCanonicalAudit returns false for non-objects (both implementations)", () => {
  assert.equal(isCanonicalShared(null), false);
  assert.equal(isCanonicalShared(undefined), false);
  assert.equal(isCanonicalShared("string"), false);
  assert.equal(isCanonicalShared(42), false);
  assert.equal(isCanonicalServiceAddIn(null), false);
  assert.equal(isCanonicalServiceAddIn(undefined), false);
  assert.equal(isCanonicalServiceAddIn("string"), false);
  assert.equal(isCanonicalServiceAddIn(42), false);
});

test("S-03: normalizeAuditRecord canonical — identical output (both implementations)", () => {
  const rec = canonicalRecord();
  const shared = normalizeShared(rec, "addin-record-1");
  const service = normalizeServiceAddIn(rec, "addin-record-1");
  assert.deepEqual(shared, service);
  assert.equal(shared.sourceFormat, "canonical");
  assert.equal(shared.auditKey, "audit-key-1");
  assert.equal(shared.bookingKey, "booking-1");
  assert.equal(shared.action, "BOOKING_APPROVED");
  assert.equal(shared.actor.userId, "user-1");
  assert.equal(shared.actor.userName, "approver@example.com");
  assert.equal(shared.actor.role, "APPROVER");
  assert.equal(shared.previousStatus, "PENDING_APPROVAL");
  assert.equal(shared.newStatus, "APPROVED");
  assert.ok(shared.changes);
  assert.ok(shared.metadata);
});

test("S-03: normalizeAuditRecord legacy booking_audit — identical output (both implementations)", () => {
  const rec = legacyRecord();
  const shared = normalizeShared(rec, "addin-record-1");
  const service = normalizeServiceAddIn(rec, "addin-record-1");
  assert.deepEqual(shared, service);
  assert.equal(shared.sourceFormat, "legacy");
  assert.equal(shared.auditKey, undefined);
  assert.equal(shared.bookingKey, "booking-1");
  assert.equal(shared.action, "BOOKING_APPROVED");
  assert.equal(shared.actor.userId, "user-1");
  assert.equal(shared.previousStatus, "PENDING_APPROVAL");
  assert.equal(shared.newStatus, "APPROVED");
  assert.equal(shared.changes, null);
  assert.equal(shared.metadata, null);
});

test("S-03: normalizeAuditRecord missing optional fields (canonical) — both implementations", () => {
  const rec = canonicalRecord({
    actor: { userId: "user-2" },
    changes: {},
    metadata: undefined,
  });
  const shared = normalizeShared(rec);
  const service = normalizeServiceAddIn(rec);
  assert.deepEqual(shared, service);
  assert.equal(shared.actor.userId, "user-2");
  assert.equal(shared.actor.userName, undefined);
  assert.equal(shared.actor.role, undefined);
  assert.equal(shared.metadata, null);
});

test("S-03: normalizeAuditRecord null values — both implementations", () => {
  const rec = canonicalRecord({
    previousStatus: null,
    newStatus: null,
    changes: null,
  });
  const shared = normalizeShared(rec);
  const service = normalizeServiceAddIn(rec);
  assert.deepEqual(shared, service);
  assert.equal(shared.previousStatus, null);
  assert.equal(shared.newStatus, null);
  assert.equal(shared.changes, null);
});

test("S-03: normalizeAuditRecord malformed records — both implementations return null", () => {
  const malformed = [
    null,
    undefined,
    "string",
    42,
    true,
    [],
    { recordType: "unknown_type" },
  ];
  for (const rec of malformed) {
    assert.equal(normalizeShared(rec), null, `shared: ${JSON.stringify(rec)}`);
    assert.equal(normalizeServiceAddIn(rec), null, `serviceAddIn: ${JSON.stringify(rec)}`);
  }
});

test("S-03: normalizeAuditRecord unknown record type — both implementations return null", () => {
  const rec = { recordType: "random_type", foo: "bar" };
  assert.equal(normalizeShared(rec), null);
  assert.equal(normalizeServiceAddIn(rec), null);
});

test("S-03: normalizeAuditRecord legacy missing schemaVersion — both implementations default to 1", () => {
  const rec = legacyRecord({ schemaVersion: undefined });
  const shared = normalizeShared(rec);
  const service = normalizeServiceAddIn(rec);
  assert.deepEqual(shared, service);
  assert.equal(shared.schemaVersion, 1);
});

test("S-03: normalizeAuditRecord canonical missing auditKey — both implementations use empty string", () => {
  const rec = canonicalRecord({ auditKey: undefined });
  const shared = normalizeShared(rec);
  const service = normalizeServiceAddIn(rec);
  assert.deepEqual(shared, service);
  assert.equal(shared.auditKey, "");
});

test("S-03: normalizeAuditRecord legacy missing actor_user_id — both implementations use empty string", () => {
  const rec = legacyRecord({ actor_user_id: undefined });
  const shared = normalizeShared(rec);
  const service = normalizeServiceAddIn(rec);
  assert.deepEqual(shared, service);
  assert.equal(shared.actor.userId, "");
});

test("S-03: normalizeAuditRecord actor object normalization — both implementations", () => {
  const rec = canonicalRecord({
    actor: { userId: "u1", userName: "u1@example.com" },
  });
  const shared = normalizeShared(rec);
  const service = normalizeServiceAddIn(rec);
  assert.deepEqual(shared, service);
  assert.equal(shared.actor.userId, "u1");
  assert.equal(shared.actor.userName, "u1@example.com");
  assert.equal(shared.actor.role, undefined);
});

test("S-03: normalizeAuditRecord status normalization — both implementations", () => {
  const rec = canonicalRecord({
    previousStatus: null,
    newStatus: "APPROVED",
  });
  const shared = normalizeShared(rec);
  const service = normalizeServiceAddIn(rec);
  assert.deepEqual(shared, service);
  assert.equal(shared.previousStatus, null);
  assert.equal(shared.newStatus, "APPROVED");
});
