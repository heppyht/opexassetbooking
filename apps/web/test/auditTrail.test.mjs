import test from "node:test";
import assert from "node:assert/strict";
import {
  emitAuditEvent,
  snapshotBooking,
  diffRelevantFields,
  resetAuditDedupForTests,
} from "../src/audit/auditTrail.ts";

function makeProvider(overrides = {}) {
  const calls = [];
  return {
    calls,
    isLive: () => false,
    async createBookingAuditEvent(input) {
      calls.push(input);
      if (overrides.fail) throw new Error(overrides.fail);
    },
    ...overrides,
  };
}

const booking = {
  id: "b1",
  requester_id: "u1",
  requester_name: "User",
  requested_class: "PASSENGER",
  asset_id: "a1",
  asset_code: "VEH-001",
  asset_name: "Car",
  registration_no: "ABC",
  start_at: "2026-11-16T08:00:00.000Z",
  end_at: "2026-11-16T09:00:00.000Z",
  buffer_before_minutes: 0,
  buffer_after_minutes: 30,
  purpose: "Trip",
  destination: "Site A",
  passenger_count: null,
  status: "PENDING_APPROVAL",
  approver_id: null,
  approval_remarks: null,
  version: 1,
  created_at: "2026-11-16T07:00:00.000Z",
  updated_at: "2026-11-16T07:00:00.000Z",
};

const authenticatedIdentity = {
  status: "authenticated",
  principal: {
    id: "verified-live-principal",
    name: "Verified User",
    roles: ["APPROVER"],
  },
  session: {},
};

test.beforeEach(() => resetAuditDedupForTests());

test("emitAuditEvent records BOOKING_CREATED with verified actor and canonical values", async () => {
  const p = makeProvider();
  const res = await emitAuditEvent({
    mode: "DEMO",
    provider: p,
    entityId: "b1",
    action: "BOOKING_CREATED",
    actorUserId: "demo-user",
    previousStatus: null,
    newStatus: "PENDING_APPROVAL",
    previous: null,
    next: snapshotBooking(booking),
    idempotencyKey: "k1",
  });
  assert.equal(res.ok, true);
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].bookingKey, "b1");
  assert.equal(p.calls[0].action, "BOOKING_CREATED");
  assert.equal(p.calls[0].actor.userId, "demo-user");
  assert.equal(p.calls[0].previousStatus, null);
  assert.equal(p.calls[0].newStatus, "PENDING_APPROVAL");
  assert.equal(p.calls[0].metadata.mode, "DEMO");
  assert.equal(p.calls[0].metadata.source, "ui.auditTrail");
  assert.ok(typeof p.calls[0].auditKey === "string" && p.calls[0].auditKey.length > 0);
  assert.ok(typeof p.calls[0].occurredAtUtc === "string");
});

test("emitAuditEvent stores only changed fields in changes", async () => {
  const p = makeProvider();
  await emitAuditEvent({
    mode: "DEMO",
    provider: p,
    entityId: "b1",
    action: "BOOKING_UPDATED",
    actorUserId: "demo-user",
    previousStatus: "PENDING_APPROVAL",
    newStatus: "APPROVED",
    previous: { status: "PENDING_APPROVAL", destination: "Site A", purpose: "Trip" },
    next: { status: "APPROVED", destination: "Site B", purpose: "Trip" },
    idempotencyKey: "k2",
  });
  assert.equal(p.calls[0].changes.status.from, "PENDING_APPROVAL");
  assert.equal(p.calls[0].changes.status.to, "APPROVED");
  assert.equal(p.calls[0].changes.destination.from, "Site A");
  assert.equal(p.calls[0].changes.destination.to, "Site B");
  assert.equal(p.calls[0].changes.purpose, undefined);
});

test("supports all required action types", async () => {
  const actions = [
    "BOOKING_CREATED", "BOOKING_UPDATED", "BOOKING_SUBMITTED", "BOOKING_APPROVED",
    "BOOKING_REJECTED", "BOOKING_CANCELLED", "BOOKING_RESCHEDULED",
    "VEHICLE_ASSIGNED", "DRIVER_ASSIGNED", "BOOKING_COMPLETED",
  ];
  for (const action of actions) {
    resetAuditDedupForTests();
    const p = makeProvider();
    const res = await emitAuditEvent({ mode: "DEMO", provider: p, entityId: "b1", action, actorUserId: "u1", idempotencyKey: action });
    assert.equal(res.ok, true, action);
    assert.equal(p.calls[0].action, action);
  }
});

test("deduplicates same logical action by idempotency key", async () => {
  const p = makeProvider();
  const input = { mode: "DEMO", provider: p, entityId: "b1", action: "BOOKING_APPROVED", actorUserId: "u1", idempotencyKey: "same" };
  const r1 = await emitAuditEvent(input);
  const r2 = await emitAuditEvent(input);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r2.deduped, true);
  assert.equal(p.calls.length, 1);
});

test("reports audit persistence failure without throwing", async () => {
  const p = makeProvider({ fail: "ADDIN_WRITE_FAILED" });
  const res = await emitAuditEvent({ mode: "ADDIN_DATA", provider: p, entityId: "b1", action: "BOOKING_APPROVED", actorUserId: "live-user", idempotencyKey: "f1", identity: authenticatedIdentity });
  assert.equal(res.ok, false);
  assert.match(res.error, /ADDIN_WRITE_FAILED/);
});

test("fails when provider cannot persist audit", async () => {
  const res = await emitAuditEvent({ mode: "DEMO", provider: { isLive: () => false }, entityId: "b1", action: "BOOKING_CREATED", actorUserId: "u1" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "AUDIT_PROVIDER_UNAVAILABLE");
});

test("LIVE mode fails closed when actor is not verified", async () => {
  const p = makeProvider();
  const res = await emitAuditEvent({ mode: "ADDIN_DATA", provider: p, entityId: "b1", action: "BOOKING_APPROVED", actorUserId: "some-user" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "AUDIT_ACTOR_UNVERIFIED");
  assert.equal(p.calls.length, 0);
});

test("LIVE actor attribution derived from verified principal (not caller-supplied)", async () => {
  const p = makeProvider();
  await emitAuditEvent({
    mode: "ADDIN_DATA",
    provider: p,
    entityId: "b1",
    action: "BOOKING_APPROVED",
    actorUserId: "imposter",
    previousStatus: "PENDING_APPROVAL",
    newStatus: "APPROVED",
    idempotencyKey: "live1",
    identity: authenticatedIdentity,
  });
  assert.equal(p.calls[0].actor.userId, "verified-live-principal");
  assert.equal(p.calls[0].actor.userName, "Verified User");
  assert.equal(p.calls[0].actor.role, "APPROVER");
  assert.equal(p.calls[0].metadata.mode, "ADDIN_DATA");
});

test("caller-supplied actorUserId that mismatches verified principal is ignored (actor derived from principal)", async () => {
  const p = makeProvider();
  const res = await emitAuditEvent({
    mode: "ADDIN_DATA",
    provider: p,
    entityId: "b1",
    action: "BOOKING_APPROVED",
    actorUserId: "imposter",
    previousStatus: "PENDING_APPROVAL",
    newStatus: "APPROVED",
    idempotencyKey: "live2",
    identity: authenticatedIdentity,
  });
  assert.equal(res.ok, true);
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].actor.userId, "verified-live-principal");
  assert.equal(p.calls[0].actor.userName, "Verified User");
  assert.equal(p.calls[0].actor.role, "APPROVER");
});

test("DEMO actor attribution preserved and isolated by mode marker", async () => {
  const p = makeProvider();
  await emitAuditEvent({ mode: "DEMO", provider: p, entityId: "b1", action: "BOOKING_CANCELLED", actorUserId: "demo-actor", previousStatus: "APPROVED", newStatus: "CANCELLED", idempotencyKey: "demo1" });
  assert.equal(p.calls[0].actor.userId, "demo-actor");
  assert.equal(p.calls[0].metadata.mode, "DEMO");
});

test("snapshotBooking maps relevant booking fields", () => {
  const snap = snapshotBooking(booking);
  assert.equal(snap.status, "PENDING_APPROVAL");
  assert.equal(snap.startAt, booking.start_at);
  assert.equal(snap.endAt, booking.end_at);
  assert.equal(snap.destination, "Site A");
  assert.equal(snap.purpose, "Trip");
  assert.equal(snap.assetId, "a1");
});

test("diff captures date/time, destination, purpose, vehicle and driver changes", () => {
  const prev = { status: "APPROVED", startAt: "2026-11-16T08:00:00Z", endAt: "2026-11-16T09:00:00Z", destination: "A", purpose: "P1", assetId: "v1", driverId: null };
  const next = { status: "ASSIGNED", startAt: "2026-11-16T10:00:00Z", endAt: "2026-11-16T11:00:00Z", destination: "B", purpose: "P2", assetId: "v2", driverId: "d1" };
  const diff = diffRelevantFields(prev, next);
  assert.ok(diff.status && diff.startAt && diff.endAt && diff.destination && diff.purpose && diff.assetId && diff.driverId);
  assert.equal(diff.destination.previous, "A");
  assert.equal(diff.destination.next, "B");
  assert.equal(diff.driverId.next, "d1");
});
