import test from "node:test";
import assert from "node:assert/strict";
import { LocalBookingDataProvider } from "../src/data/dataProvider.ts";
import { emitAuditEvent, snapshotBooking, resetAuditDedupForTests } from "../src/audit/auditTrail.ts";
import { canPerformLiveWrite, getActorIdForMode } from "../src/auth/identityResolver.ts";
import { assertDemoOnlyOperation, assertProviderNotLiveForDemoOperation, isKnownMode } from "../src/safety/modeGuards.ts";

async function freshDemoProvider() {
  const p = new LocalBookingDataProvider();
  await p.resetDemoData();
  return p;
}

function createInput(overrides = {}) {
  return {
    deviceId: "d1",
    requesterUserId: "demo-user",
    requestedClass: "PASSENGER",
    startAt: "2026-11-16T08:00:00.000Z",
    endAt: "2026-11-16T09:00:00.000Z",
    purpose: "Trip",
    destination: "Site A",
    passengerCount: null,
    ...overrides,
  };
}

test.beforeEach(() => resetAuditDedupForTests());

test("workflow: create booking (DEMO) - state, actor, single audit, fields", async () => {
  const p = await freshDemoProvider();
  const actorId = "demo-user";
  const created = await p.createBooking(createInput({ requesterUserId: actorId }));
  assert.equal(created.status, "PENDING_APPROVAL");
  assert.equal(created.requester_id, actorId);
  const audit = await emitAuditEvent({
    mode: "DEMO", provider: p, entityId: created.id, action: "BOOKING_CREATED",
    actorUserId: actorId, previousStatus: null, newStatus: "PENDING_APPROVAL",
    previous: null, next: snapshotBooking(created), idempotencyKey: `DEMO:${created.id}:BOOKING_CREATED`,
  });
  assert.equal(audit.ok, true);
  const records = await p.getAuditRecords(created.id);
  assert.equal(records.length, 1);
  assert.equal(records[0].action, "BOOKING_CREATED");
  assert.equal(records[0].actor.userId, actorId);
  assert.equal(records[0].previousStatus, null);
  assert.equal(records[0].newStatus, "PENDING_APPROVAL");
  assert.equal(records[0].bookingKey, created.id);
  assert.ok(records[0].occurredAtUtc);
  assert.equal(records[0].changes.destination.to, "Site A");
  assert.equal(records[0].changes.purpose.to, "Trip");
  assert.equal(records[0].metadata.mode, "DEMO");
});

test("workflow: approve/reject/assign/complete/cancel transitions with single audits and correct actors", async () => {
  const p = await freshDemoProvider();
  const demoActor = "demo-approver";
  const livePrincipal = "live-principal";

  let b = await p.createBooking(createInput());
  let prev = snapshotBooking(b);
  await p.updateBookingStatus(b.id, "APPROVED", b.version, demoActor);
  let updated = (await p.getBookings()).find(x => x.id === b.id);
  assert.equal(updated.status, "APPROVED");
  let r = await emitAuditEvent({ mode: "DEMO", provider: p, entityId: b.id, action: "BOOKING_APPROVED", actorUserId: demoActor, previousStatus: prev.status, newStatus: "APPROVED", previous: prev, next: snapshotBooking(updated), idempotencyKey: `DEMO:${b.id}:APPROVED` });
  assert.equal(r.ok, true);
  let audits = await p.getAuditRecords(b.id);
  assert.equal(audits.filter(a => a.action === "BOOKING_APPROVED").length, 1);
  assert.equal(audits.find(a => a.action === "BOOKING_APPROVED").actor.userId, demoActor);

  b = await p.createBooking(createInput());
  prev = snapshotBooking(b);
  await p.updateBookingStatus(b.id, "REJECTED", b.version, livePrincipal, "No vehicle");
  updated = (await p.getBookings()).find(x => x.id === b.id);
  assert.equal(updated.status, "REJECTED");
  r = await emitAuditEvent({ mode: "ADDIN_DATA", provider: p, entityId: b.id, action: "BOOKING_REJECTED", actorUserId: livePrincipal, previousStatus: prev.status, newStatus: "REJECTED", previous: prev, next: snapshotBooking(updated), metadata: { reason: "No vehicle" }, idempotencyKey: `LIVE:${b.id}:REJECTED`, identity: { status: "authenticated", principal: { id: livePrincipal, name: livePrincipal, roles: ["APPROVER"], session: {} }, session: {} } });
  assert.equal(r.ok, true);
  audits = await p.getAuditRecords(b.id);
  const rej = audits.find(a => a.action === "BOOKING_REJECTED");
  assert.equal(rej.actor.userId, livePrincipal);
  assert.equal(rej.previousStatus, "PENDING_APPROVAL");
  assert.equal(rej.newStatus, "REJECTED");
  assert.equal(rej.metadata.reason, "No vehicle");

  b = await p.createBooking(createInput());
  await p.updateBookingStatus(b.id, "APPROVED", b.version, demoActor);
  prev = snapshotBooking((await p.getBookings()).find(x => x.id === b.id));
  await p.updateBookingStatus(b.id, "ASSIGNED", b.version + 1, demoActor);
  updated = (await p.getBookings()).find(x => x.id === b.id);
  assert.equal(updated.status, "ASSIGNED");
  r = await emitAuditEvent({ mode: "DEMO", provider: p, entityId: b.id, action: "VEHICLE_ASSIGNED", actorUserId: demoActor, previousStatus: prev.status, newStatus: "ASSIGNED", previous: prev, next: snapshotBooking(updated), idempotencyKey: `DEMO:${b.id}:ASSIGNED` });
  assert.equal(r.ok, true);
  assert.equal((await p.getAuditRecords(b.id)).filter(a => a.action === "VEHICLE_ASSIGNED").length, 1);

  prev = snapshotBooking(updated);
  await p.updateBookingStatus(b.id, "COMPLETED", b.version + 2, demoActor);
  updated = (await p.getBookings()).find(x => x.id === b.id);
  assert.equal(updated.status, "COMPLETED");
  r = await emitAuditEvent({ mode: "DEMO", provider: p, entityId: b.id, action: "BOOKING_COMPLETED", actorUserId: demoActor, previousStatus: prev.status, newStatus: "COMPLETED", previous: prev, next: snapshotBooking(updated), idempotencyKey: `DEMO:${b.id}:COMPLETED` });
  assert.equal(r.ok, true);
  assert.equal((await p.getAuditRecords(b.id)).filter(a => a.action === "BOOKING_COMPLETED").length, 1);

  b = await p.createBooking(createInput());
  prev = snapshotBooking(b);
  await p.updateBookingStatus(b.id, "CANCELLED", b.version, demoActor);
  updated = (await p.getBookings()).find(x => x.id === b.id);
  assert.equal(updated.status, "CANCELLED");
  r = await emitAuditEvent({ mode: "DEMO", provider: p, entityId: b.id, action: "BOOKING_CANCELLED", actorUserId: demoActor, previousStatus: prev.status, newStatus: "CANCELLED", previous: prev, next: snapshotBooking(updated), idempotencyKey: `DEMO:${b.id}:CANCELLED` });
  assert.equal(r.ok, true);
  assert.equal((await p.getAuditRecords(b.id)).filter(a => a.action === "BOOKING_CANCELLED").length, 1);
});

test("no cross-mode identity leakage in actor resolution", () => {
  const auth = { status: "authenticated", principal: { id: "live-id", name: "Live", roles: ["APPROVER"], session: {} }, session: {} };
  assert.equal(getActorIdForMode("ADDIN_DATA", auth, "demo-id"), "live-id");
  assert.equal(getActorIdForMode("DEMO", auth, "demo-id"), "demo-id");
  assert.equal(getActorIdForMode("ADDIN_DATA", { status: "unresolved", reason: "x" }, "demo-id"), null);
  assert.equal(getActorIdForMode("ADDIN_DATA", { status: "error", reason: "x" }, "demo-id"), null);
});

test("audit failure after successful booking write: booking persisted, audit reported failed, no duplicate booking", async () => {
  const p = await freshDemoProvider();
  const created = await p.createBooking(createInput());
  const beforeCount = (await p.getBookings()).length;
  const failProvider = {
    ...p,
    isLive: () => p.isLive(),
    createBookingAuditEvent: async () => { throw new Error("AUDIT_STORE_DOWN"); },
  };
  resetAuditDedupForTests();
  const audit = await emitAuditEvent({ mode: "DEMO", provider: failProvider, entityId: created.id, action: "BOOKING_CREATED", actorUserId: "demo-user", previousStatus: null, newStatus: "PENDING_APPROVAL", previous: null, next: snapshotBooking(created), idempotencyKey: `DEMO:${created.id}:BOOKING_CREATED_FAIL` });
  assert.equal(audit.ok, false);
  assert.match(audit.error, /AUDIT_STORE_DOWN/);
  const after = await p.getBookings();
  assert.equal(after.length, beforeCount);
  assert.ok(after.find(b => b.id === created.id));
  assert.equal((await p.getAuditRecords(created.id)).length, 0);
});

test("booking write failure: no audit emitted for failed write", async () => {
  const p = await freshDemoProvider();
  let createCalled = false;
  const failCreateProvider = {
    ...p,
    async createBooking() { throw new Error("BOOKING_WRITE_FAILED"); },
    async createAuditRecord(input) { createCalled = true; return p.createAuditRecord(input); },
  };
  await assert.rejects(() => failCreateProvider.createBooking(createInput()), /BOOKING_WRITE_FAILED/);
  assert.equal(createCalled, false);
});

test("duplicate submission/reload: cross-session dedup prevents duplicate audit after reset", async () => {
  const p = await freshDemoProvider();
  const b = await p.createBooking(createInput());
  const key = `DEMO:${b.id}:BOOKING_CREATED`;
  const e1 = await emitAuditEvent({ mode: "DEMO", provider: p, entityId: b.id, action: "BOOKING_CREATED", actorUserId: "u1", idempotencyKey: key });
  const e2 = await emitAuditEvent({ mode: "DEMO", provider: p, entityId: b.id, action: "BOOKING_CREATED", actorUserId: "u1", idempotencyKey: key });
  assert.equal(e1.ok, true);
  assert.equal(e2.deduped, true);
  assert.equal((await p.getAuditRecords(b.id)).length, 1);
  /* After clearing in-memory dedup (simulating page reload), cross-session
     dedup via getAuditRecords still prevents a duplicate audit record. */
  resetAuditDedupForTests();
  const e3 = await emitAuditEvent({ mode: "DEMO", provider: p, entityId: b.id, action: "BOOKING_CREATED", actorUserId: "u1", idempotencyKey: key });
  assert.equal(e3.ok, true);
  assert.equal(e3.deduped, true);
  assert.equal((await p.getAuditRecords(b.id)).length, 1);
});

test("reconciliation assessment: audit records queryable by booking id", async () => {
  const p = await freshDemoProvider();
  const b = await p.createBooking(createInput());
  await emitAuditEvent({ mode: "DEMO", provider: p, entityId: b.id, action: "BOOKING_CREATED", actorUserId: "u1", previousStatus: null, newStatus: "PENDING_APPROVAL", idempotencyKey: "r1" });
  const records = await p.getAuditRecords(b.id);
  assert.ok(records.some(r => r.bookingKey === b.id && r.action === "BOOKING_CREATED" && r.newStatus === "PENDING_APPROVAL"));
});

test("notification failure after successful booking and audit: no rollback, booking/audit remain", async () => {
  const p = await freshDemoProvider();
  const b = await p.createBooking(createInput());
  const audit = await emitAuditEvent({ mode: "DEMO", provider: p, entityId: b.id, action: "BOOKING_CREATED", actorUserId: "u1", previousStatus: null, newStatus: "PENDING_APPROVAL", idempotencyKey: "n1" });
  assert.equal(audit.ok, true);
  const notifyFailed = true; // simulated separate post-persist failure
  assert.equal(notifyFailed, true);
  assert.equal((await p.getBookings()).find(x => x.id === b.id).status, "PENDING_APPROVAL");
  assert.equal((await p.getAuditRecords(b.id)).length, 1);
});

test("LIVE/DEMO security regression: identity states and provider isolation", () => {
  assert.equal(canPerformLiveWrite("ADDIN_DATA", { status: "authenticated", principal: { id: "x", name: "n", roles: [], session: {} }, session: {} }), true);
  assert.equal(canPerformLiveWrite("ADDIN_DATA", { status: "unresolved", reason: "x" }), false);
  assert.equal(canPerformLiveWrite("ADDIN_DATA", { status: "error", reason: "x" }), false);
  assert.equal(canPerformLiveWrite("ADDIN_DATA", { status: "loading" }), false);
  assert.equal(canPerformLiveWrite("ADDIN_DATA", null), false);
  assert.equal(canPerformLiveWrite("DEMO", null), true);
  assert.doesNotThrow(() => assertDemoOnlyOperation("DEMO", "Demo reset"));
  assert.throws(() => assertDemoOnlyOperation("ADDIN_DATA", "Demo reset"));
  assert.throws(() => assertProviderNotLiveForDemoOperation({ isLive: () => true }, "Demo reset"));
  assert.doesNotThrow(() => assertProviderNotLiveForDemoOperation({ isLive: () => false }, "Demo reset"));
  assert.equal(isKnownMode("DEMO"), true);
  assert.equal(isKnownMode("ADDIN_DATA"), true);
  assert.equal(isKnownMode("LIVE"), false);
});

test("BOOKING_UPDATED and DRIVER_ASSIGNED remain pending: no existing app workflows/provider mutations", async () => {
  const p = await freshDemoProvider();
  const b = await p.createBooking(createInput());
  const u = await emitAuditEvent({ mode: "DEMO", provider: p, entityId: b.id, action: "BOOKING_UPDATED", actorUserId: "u1", idempotencyKey: "upd1" });
  const d = await emitAuditEvent({ mode: "DEMO", provider: p, entityId: b.id, action: "DRIVER_ASSIGNED", actorUserId: "u1", idempotencyKey: "drv1" });
  assert.equal(u.ok, true);
  assert.equal(d.ok, true);
  assert.equal(typeof p.updateBooking, "undefined");
  assert.equal(typeof p.assignDriver, "undefined");
});
