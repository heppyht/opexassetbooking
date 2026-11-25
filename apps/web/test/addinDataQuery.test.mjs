/*───────────────────── AddInData Selective Query Tests ─────────────────────*/
/* Verifies the performance optimizations in AddInDataBookingDataProvider:
   - Selective (whereClause) + bounded (resultsLimit) AddInData queries.
   - Request deduplication / short-TTL caching (identical reads share a fetch).
   - Cache invalidation after writes.
   - Lazy loading (notifications do not fetch master data).
   - Master data batched via ExecuteMultiCall and cached.

   The mock API honors search.whereClause ("details.recordType = \"X\""),
   search.resultsLimit, and ExecuteMultiCall, and records every call. */

import test from "node:test";
import assert from "node:assert/strict";
import { AddInDataBookingDataProvider } from "../src/data/addinDataProvider.ts";
import { DEFAULT_ADDIN_ID } from "../src/config/addinId.ts";

/*───────────────────── Mock API ─────────────────────*/

function safeParse(v) {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

function makeApi(opts = {}) {
  const calls = [];
  const records = []; // { id, details, addInId }
  let serverCounter = 0;
  const devices = opts.devices ?? [];
  const users = opts.users ?? [];
  const groups = opts.groups ?? [];

  const slice = (arr, search) => {
    let out = arr;
    if (typeof search?.resultsLimit === "number") out = out.slice(0, search.resultsLimit);
    return out;
  };

  const runGet = (params) => {
    const { typeName, search } = params;
    if (typeName === "Device") return slice(devices, search);
    if (typeName === "User") return slice(users, search);
    if (typeName === "Group") return slice(groups, search);
    if (typeName === "AddInData") {
      let out = records.map((r) => ({ id: r.id, details: r.details }));
      const wc = search?.whereClause;
      if (wc) {
        const m = /details\.recordType\s*=\s*"([^"]+)"/.exec(wc);
        if (m) {
          const rt = m[1];
          out = out.filter((r) => safeParse(r.details)?.recordType === rt);
        }
      }
      if (typeof search?.resultsLimit === "number") out = out.slice(0, search.resultsLimit);
      return out;
    }
    return [];
  };

  const api = {
    call: (method, params, success, error) => {
      let cloned;
      try {
        cloned = params === undefined ? null : JSON.parse(JSON.stringify(params));
      } catch {
        cloned = params ?? null;
      }
      calls.push({ method, params: cloned });
      try {
        if (method === "Get") return success(runGet(params));
        if (method === "ExecuteMultiCall") {
          return success(params.calls.map((c) => runGet(c.params)));
        }
        if (method === "Add") {
          const id = `rec-${++serverCounter}`;
          records.push({ id, details: params.entity.details, addInId: params.entity.addInId });
          return success({ id });
        }
        if (method === "Set") {
          const idx = records.findIndex((r) => r.id === params.entity.id);
          if (idx === -1) return error(new Error("RECORD_NOT_FOUND"));
          records[idx] = { id: params.entity.id, details: params.entity.details, addInId: params.entity.addInId };
          return success({});
        }
        if (method === "Remove" || method === "Delete") {
          const idx = records.findIndex((r) => r.id === params.entity.id);
          if (idx === -1) return error(new Error("RECORD_NOT_FOUND"));
          records.splice(idx, 1);
          return success({});
        }
        return success(null);
      } catch (e) {
        error(e);
      }
    },
  };

  return {
    api,
    calls,
    records,
    seed(details) {
      const id = `rec-${++serverCounter}`;
      records.push({ id, details, addInId: DEFAULT_ADDIN_ID });
      return id;
    },
  };
}

/*───────────────────── Helpers ─────────────────────*/

function bookingDetails(id, overrides = {}) {
  return {
    recordType: "booking",
    schemaVersion: 1,
    id,
    deviceId: "dev-1",
    requesterUserId: "u-1",
    requestedClass: "PASSENGER",
    startAt: "2026-11-16T09:00:00.000Z",
    endAt: "2026-11-16T10:00:00.000Z",
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 30,
    purpose: "Site visit",
    destination: "HQ",
    passengerCount: 1,
    status: "PENDING_APPROVAL",
    assignedDriverUserId: null,
    approverId: null,
    approvalRemarks: null,
    createdAt: "2026-11-16T08:00:00.000Z",
    updatedAt: "2026-11-16T08:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

function notificationDetails(id, overrides = {}) {
  return {
    recordType: "notification",
    schemaVersion: 1,
    id,
    eventId: `evt-${id}`,
    idempotencyKey: `key-${id}`,
    type: "booking_created",
    recipient_user_id: "u-1",
    related_booking_id: null,
    title: "T",
    message: "M",
    is_read: false,
    delivery_status: "pending",
    delivered_at: null,
    created_at: "2026-11-16T08:00:00.000Z",
    updated_at: "2026-11-16T08:00:00.000Z",
    ...overrides,
  };
}

function auditDetails(id, overrides = {}) {
  return {
    recordType: "booking_audit",
    schemaVersion: 1,
    id,
    booking_id: "b-1",
    action: "BOOKING_CREATED",
    actor_user_id: "u-1",
    previous_status: null,
    new_status: "PENDING_APPROVAL",
    details: null,
    created_at: "2026-11-16T08:00:00.000Z",
    ...overrides,
  };
}

const addInDataGets = (ctx) => ctx.calls.filter((c) => c.method === "Get" && c.params?.typeName === "AddInData");
const deviceGets = (ctx) => ctx.calls.filter((c) => c.method === "Get" && c.params?.typeName === "Device");
const userGets = (ctx) => ctx.calls.filter((c) => c.method === "Get" && c.params?.typeName === "User");
const execCalls = (ctx) => ctx.calls.filter((c) => c.method === "ExecuteMultiCall");

/*───────────────────── Tests ─────────────────────*/

test("getBookings uses a selective, bounded AddInData query and batched master data", async () => {
  const ctx = makeApi({
    devices: [{ id: "dev-1", name: "AD 1_Toyota Hilux_Driver", licensePlate: "AD 1" }],
    users: [{ id: "u-1", name: "User One" }],
  });
  ctx.seed(bookingDetails("b-1"));
  ctx.seed(notificationDetails("n-1")); // must be excluded by the selective query
  ctx.seed(auditDetails("a-1")); // must be excluded

  const provider = new AddInDataBookingDataProvider(ctx.api, DEFAULT_ADDIN_ID);
  const bookings = await provider.getBookings();

  const gets = addInDataGets(ctx);
  assert.equal(gets.length, 1, "One AddInData Get expected");
  const search = gets[0].params.search;
  assert.equal(typeof search.resultsLimit, "number", "resultsLimit must be bounded");
  assert.match(search.whereClause, /recordType = "booking"/);

  // Only the booking record is returned (notification/audit filtered server-side).
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].id, "b-1");
  // Master data resolved the asset + requester names.
  assert.equal(bookings[0].requester_name, "User One");
  assert.ok(bookings[0].asset_name);

  // Master data fetched via a single ExecuteMultiCall round-trip.
  assert.equal(execCalls(ctx).length, 1, "Master data should use one ExecuteMultiCall");
});

test("getNotifications is selective and lazy (no master-data fetch)", async () => {
  const ctx = makeApi();
  ctx.seed(notificationDetails("n-1", { recipient_user_id: "u-1" }));
  ctx.seed(notificationDetails("n-2", { recipient_user_id: "u-2" }));
  ctx.seed(bookingDetails("b-1")); // must be excluded

  const provider = new AddInDataBookingDataProvider(ctx.api, DEFAULT_ADDIN_ID);
  const notes = await provider.getNotifications("u-1");

  const gets = addInDataGets(ctx);
  assert.equal(gets.length, 1);
  assert.match(gets[0].params.search.whereClause, /recordType = "notification"/);
  assert.equal(typeof gets[0].params.search.resultsLimit, "number");

  // Lazy: no Device/User/Group fetches triggered by a notifications read.
  assert.equal(execCalls(ctx).length, 0, "Notifications must not fetch master data");
  assert.equal(deviceGets(ctx).length, 0);
  assert.equal(userGets(ctx).length, 0);

  assert.equal(notes.length, 1);
  assert.equal(notes[0].id, "n-1");
});

test("getUnreadCount uses the notification query", async () => {
  const ctx = makeApi();
  ctx.seed(notificationDetails("n-1", { recipient_user_id: "u-1", is_read: false }));
  ctx.seed(notificationDetails("n-2", { recipient_user_id: "u-1", is_read: true }));

  const provider = new AddInDataBookingDataProvider(ctx.api, DEFAULT_ADDIN_ID);
  const count = await provider.getUnreadCount("u-1");

  assert.equal(count, 1);
  assert.match(addInDataGets(ctx)[0].params.search.whereClause, /recordType = "notification"/);
});

test("getAuditRecords is selective to booking_audit and filtered by booking", async () => {
  const ctx = makeApi();
  ctx.seed(auditDetails("a-1", { booking_id: "b-1" }));
  ctx.seed(auditDetails("a-2", { booking_id: "b-1" }));
  ctx.seed(auditDetails("a-3", { booking_id: "b-2" }));

  const provider = new AddInDataBookingDataProvider(ctx.api, DEFAULT_ADDIN_ID);
  const audits = await provider.getAuditRecords("b-1");

  assert.match(addInDataGets(ctx)[0].params.search.whereClause, /recordType = "booking_audit"/);
  assert.equal(audits.length, 2);
  assert.ok(audits.every((a) => a.bookingKey === "b-1"));
});

test("concurrent identical getBookings share a single AddInData request (dedup)", async () => {
  const ctx = makeApi();
  ctx.seed(bookingDetails("b-1"));

  const provider = new AddInDataBookingDataProvider(ctx.api, DEFAULT_ADDIN_ID);
  const [a, b, c] = await Promise.all([
    provider.getBookings(),
    provider.getBookings(),
    provider.getBookings(),
  ]);

  assert.equal(addInDataGets(ctx).length, 1, "Identical concurrent reads must coalesce to one request");
  assert.equal(a.length, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test("repeated getBookings within TTL does not refetch AddInData or master data", async () => {
  const ctx = makeApi({ devices: [{ id: "dev-1", name: "X" }], users: [{ id: "u-1", name: "U" }] });
  ctx.seed(bookingDetails("b-1"));

  const provider = new AddInDataBookingDataProvider(ctx.api, DEFAULT_ADDIN_ID);
  await provider.getBookings();
  await provider.getBookings();
  await provider.getBookings();

  assert.equal(addInDataGets(ctx).length, 1, "Records served from cache after first read");
  assert.equal(execCalls(ctx).length, 1, "Master data served from cache after first read");
});

test("cache invalidation after a write surfaces the new booking", async () => {
  const ctx = makeApi({ devices: [{ id: "dev-1", name: "X" }], users: [{ id: "u-1", name: "U" }] });

  const provider = new AddInDataBookingDataProvider(ctx.api, DEFAULT_ADDIN_ID);
  const before = await provider.getBookings();
  assert.equal(before.length, 0);

  const created = await provider.createBooking({
    deviceId: "dev-1",
    requesterUserId: "u-1",
    requestedClass: "PASSENGER",
    startAt: "2026-11-16T09:00:00.000Z",
    endAt: "2026-11-16T10:00:00.000Z",
    purpose: "Trip",
    destination: "Site",
    passengerCount: 1,
  });
  assert.ok(created.id);

  const after = await provider.getBookings();
  assert.equal(after.length, 1, "Write should invalidate the read cache");
  assert.equal(after[0].id, created.id);
});

test("findByIdempotencyKey uses the notification query and matches", async () => {
  const ctx = makeApi();
  ctx.seed(notificationDetails("n-1", { idempotencyKey: "notif:booking_created:b-1:u-1" }));

  const provider = new AddInDataBookingDataProvider(ctx.api, DEFAULT_ADDIN_ID);
  const found = await provider.findByIdempotencyKey("notif:booking_created:b-1:u-1");

  assert.match(addInDataGets(ctx)[0].params.search.whereClause, /recordType = "notification"/);
  assert.ok(found);
  assert.equal(found.id, "n-1");

  const missing = await provider.findByIdempotencyKey("does-not-exist");
  assert.equal(missing, null);
});

test("all AddInData reads are bounded with a numeric resultsLimit", async () => {
  const ctx = makeApi();
  ctx.seed(bookingDetails("b-1"));
  ctx.seed(notificationDetails("n-1"));
  ctx.seed(auditDetails("a-1"));
  ctx.seed({ recordType: "audit_dead_letter", schemaVersion: 1, id: "d-1", booking_id: "b-1", action: "X", actor_user_id: "u", previous_status: null, new_status: null, details: null, created_at: "2026-11-16T08:00:00.000Z", retry_count: 1, max_retries: 5, last_error: null, next_retry_at: null, dead_lettered_at: "2026-11-16T08:00:00.000Z", original_pending_id: "p-1" });

  const provider = new AddInDataBookingDataProvider(ctx.api, DEFAULT_ADDIN_ID);
  await provider.getBookings();
  await provider.getNotifications("u-1");
  await provider.getAuditRecords("b-1");
  await provider.getAuditPending();
  await provider.getAuditDeadLetters();

  const gets = addInDataGets(ctx);
  assert.ok(gets.length > 0);
  for (const g of gets) {
    assert.equal(typeof g.params.search.resultsLimit, "number", "Every AddInData Get must set resultsLimit");
    assert.ok(g.params.search.resultsLimit > 0);
  }
});