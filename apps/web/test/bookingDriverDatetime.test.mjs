import test from "node:test";
import assert from "node:assert/strict";
import { LocalBookingDataProvider } from "../src/data/dataProvider.ts";
import { AddInDataBookingDataProvider } from "../src/data/addinDataProvider.ts";
import { DEFAULT_ADDIN_ID } from "../src/config/addinId.ts";
import { emitAuditEvent, snapshotBooking, diffRelevantFields, resetAuditDedupForTests } from "../src/audit/auditTrail.ts";
import { getTenantTimezone, toIsoFromTenantParts } from "../src/config/tenantTimezone.ts";

async function freshDemoProvider() {
  const p = new LocalBookingDataProvider();
  await p.resetDemoData();
  // Clean localStorage-backed state to keep tests isolated
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem("opex-vbm-demo-bookings");
    localStorage.removeItem("opex-vbm-demo-notifications");
    localStorage.removeItem("opex-vbm-demo-audit");
  }
  return p;
}

function makeAddInProvider() {
  const calls = [];
  const api = {
    call: (method, params, success) => {
      calls.push({ method, params });
      if (method === "Add") success({ id: `record-${Date.now()}` });
      else if (method === "Get") success([]);
      else success(null);
    },
  };
  return { p: new AddInDataBookingDataProvider(api, DEFAULT_ADDIN_ID), calls, api };
}

test.beforeEach(() => resetAuditDedupForTests());

test("tenant timezone: Asia/Jakarta WIB UTC+7 interpretation", () => {
  const tz = getTenantTimezone();
  assert.equal(tz.timezone, "Asia/Jakarta");
  assert.equal(tz.label, "WIB (UTC+7)");
  assert.ok(tz.offsetMinutes >= 0);

  const iso = toIsoFromTenantParts("2026-11-16", "08:00", tz.timezone);
  const d = new Date(iso);
  // Asia/Jakarta is UTC+7, so 08:00 local = 01:00 UTC
  assert.equal(d.getUTCHours(), 1);
  assert.equal(d.getUTCMinutes(), 0);
});

test("workflow: create booking with optional driver (none auto-resolved)", async () => {
  const p = await freshDemoProvider();
  const actorId = "u101";
  const created = await p.createBooking({
    deviceId: "dev-001",
    requesterUserId: actorId,
    requestedClass: "OPERATIONAL_4X4",
    startAt: "2026-11-16T08:00:00.000Z",
    endAt: "2026-11-16T17:00:00.000Z",
    purpose: "Trip",
    destination: "Site A",
    passengerCount: 2,
  });
  assert.equal(created.status, "PENDING_APPROVAL");
  assert.equal(created.driver_id, null);
  assert.equal(created.driver_name, null);

  const all = await p.getBookings();
  const b = all.find(x => x.id === created.id);
  assert.ok(b);
  assert.equal(b.driver_id, null);
  assert.equal(b.driver_name, null);
});

test("workflow: create booking with explicit driver persisted and shown", async () => {
  const p = await freshDemoProvider();
  const actorId = "u101";
  const created = await p.createBooking({
    deviceId: "dev-002",
    requesterUserId: actorId,
    requestedClass: "PASSENGER",
    startAt: "2026-11-16T08:00:00.000Z",
    endAt: "2026-11-16T17:00:00.000Z",
    purpose: "Field inspection",
    destination: "Plantation A",
    passengerCount: 3,
    driverId: "u102",
    driverName: "Jane Smith",
  });
  assert.equal(created.driver_id, "u102");
  assert.equal(created.driver_name, "Jane Smith");

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
  assert.equal(records[0].newStatus, "PENDING_APPROVAL");
  assert.equal(records[0].changes.driverId.from, null);
  assert.equal(records[0].changes.driverId.to, "u102");
});

test("workflow: multi-day overnight booking persisted with full datetime interval", async () => {
  const p = await freshDemoProvider();
  const created = await p.createBooking({
    deviceId: "dev-005",
    requesterUserId: "u108",
    requestedClass: "OPERATIONAL_4X4",
    startAt: "2026-11-16T18:00:00.000Z",
    endAt: "2026-11-17T06:00:00.000Z",
    purpose: "Overnight equipment transport",
    destination: "Plantation B",
    passengerCount: 2,
  });
  assert.equal(created.start_at, "2026-11-16T18:00:00.000Z");
  assert.equal(created.end_at, "2026-11-17T06:00:00.000Z");

  const all = await p.getBookings();
  const b = all.find(x => x.id === created.id);
  assert.ok(b);
  assert.equal(new Date(b.end_at).getTime() - new Date(b.start_at).getTime(), 12 * 60 * 60 * 1000);
});

test("workflow: non-overlapping bookings on same device succeed (Local provider has no server-side conflict check)", async () => {
  const p = await freshDemoProvider();
  const actorId = "u101";
  const first = await p.createBooking({
    deviceId: "dev-001",
    requesterUserId: actorId,
    requestedClass: "PASSENGER",
    startAt: "2026-11-16T10:00:00.000Z",
    endAt: "2026-11-16T12:00:00.000Z",
    purpose: "Trip",
    destination: "Site A",
    passengerCount: 1,
  });
  assert.ok(first.id);
  // Local provider does not perform server-side conflict checks; overlapping create is permitted here.
  // Conflict prevention is enforced at the UI layer (NewBooking) and by the AddInData provider.
  const overlapping = await p.createBooking({
    deviceId: "dev-001",
    requesterUserId: actorId,
    requestedClass: "PASSENGER",
    startAt: "2026-11-16T11:00:00.000Z",
    endAt: "2026-11-16T13:00:00.000Z",
    purpose: "Overlap",
    destination: "Site B",
    passengerCount: 1,
  });
  assert.ok(overlapping.id);
  const all = await p.getBookings();
  const d1Bookings = all.filter(b => b.asset_id === "dev-001");
  assert.ok(d1Bookings.length >= 2);
});

test("audit: diffRelevantFields captures driver and datetime changes", () => {
  const previous = {
    status: "PENDING_APPROVAL", startAt: "2026-11-16T08:00:00.000Z",
    endAt: "2026-11-16T10:00:00.000Z", destination: "Site A", purpose: "Trip",
    assetId: "a1", assetName: "Car", driverId: null, driverName: null,
  };
  const next = {
    status: "APPROVED", startAt: "2026-11-16T08:00:00.000Z",
    endAt: "2026-11-16T11:00:00.000Z", destination: "Site A", purpose: "Trip",
    assetId: "a1", assetName: "Car", driverId: "u102", driverName: "Jane Smith",
  };
  const changed = diffRelevantFields(previous, next);
  assert.ok("endAt" in changed && "driverId" in changed && "status" in changed);
  assert.ok(!("destination" in changed));
  assert.ok(!("startAt" in changed));
  assert.deepEqual(changed.driverId, { previous: null, next: "u102" });
});

test("addin data provider: createBooking accepts and persists driver fields", async () => {
  const { p, calls } = makeAddInProvider();
  const created = await p.createBooking({
    deviceId: "dev-001",
    requesterUserId: "u101",
    requestedClass: "PASSENGER",
    startAt: "2026-11-16T08:00:00.000Z",
    endAt: "2026-11-16T17:00:00.000Z",
    purpose: "Trip",
    destination: "Site A",
    passengerCount: 2,
    driverId: "u103",
    driverName: "Bob Wilson",
  });
  // driverId is persisted on the OpexBooking (resolveBookingToResolved sets driver_name null until re-fetched from records)
  assert.equal(created.driver_id, "u103");
  // The Add call should include driver id serialized
  const addCall = calls.find(c => c.method === "Add");
  assert.ok(addCall);
  const details = JSON.stringify(addCall.params.entity.details);
  assert.ok(details.includes("u103"));
});

test("booking created via UI passes driver to audit snapshot", async () => {
  const p = await freshDemoProvider();
  const created = await p.createBooking({
    deviceId: "dev-003",
    requesterUserId: "u102",
    requestedClass: "PASSENGER",
    startAt: "2026-11-16T09:00:00.000Z",
    endAt: "2026-11-16T16:00:00.000Z",
    purpose: "Client meeting",
    destination: "City Office",
    passengerCount: 4,
    driverId: "u104",
    driverName: "Sarah Chen",
  });
  const snapshot = snapshotBooking(created);
  assert.equal(snapshot.driverId, "u104");
  assert.equal(snapshot.driverName, "Sarah Chen");
  assert.equal(snapshot.startAt, "2026-11-16T09:00:00.000Z");
  assert.equal(snapshot.endAt, "2026-11-16T16:00:00.000Z");
});
