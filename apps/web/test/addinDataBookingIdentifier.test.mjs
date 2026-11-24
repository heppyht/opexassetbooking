import test from "node:test";
import assert from "node:assert/strict";
import { AddInDataBookingDataProvider } from "../src/data/addinDataProvider.ts";
import { DEFAULT_ADDIN_ID } from "../src/config/addinId.ts";

/*───────────────────── Mock MyGeotab AddInData API ─────────────────────*/
/* Simulates server-assigned record IDs: Add generates rec-N, details keep
   the client-generated booking id (addin-<ts>). Set/Remove operate on
   record.id (server ID). */

function makeMockApi() {
  const records = []; // { id: string /* server record id */, details: unknown }
  const calls = [];
  let serverCounter = 0;

  return {
    records,
    calls,
    call: (method, params, success, error) => {
      calls.push({ method, params });
      try {
        if (method === "Add") {
          const serverId = `rec-${++serverCounter}`;
          const record = { id: serverId, details: params.entity.details };
          records.push(record);
          success({ id: serverId });
        } else if (method === "Get") {
          const { typeName, search } = params;
          if (typeName === "AddInData") {
            const addInId = search?.addInId;
            const filtered = records.filter(r => !addInId || true);
            success(filtered.map(r => ({ id: r.id, details: r.details })));
          } else if (typeName === "Device") {
            success([]);
          } else if (typeName === "User") {
            success([]);
          } else {
            success([]);
          }
        } else if (method === "Set") {
          const idx = records.findIndex(r => r.id === params.entity.id);
          if (idx === -1) {
            error(new Error("RECORD_NOT_FOUND"));
          } else {
            records[idx] = { id: params.entity.id, details: params.entity.details };
            success({});
          }
        } else if (method === "Remove") {
          const idx = records.findIndex(r => r.id === params.entity.id);
          if (idx === -1) {
            error(new Error("RECORD_NOT_FOUND"));
          } else {
            records.splice(idx, 1);
            success({});
          }
        } else {
          error(new Error(`Unknown method: ${method}`));
        }
      } catch (e) {
        error(e);
      }
    },
  };
}

function baseBookingInput(overrides = {}) {
  return {
    deviceId: "dev-001",
    requesterUserId: "u101",
    requestedClass: "PASSENGER",
    startAt: "2026-11-17T08:00:00.000Z",
    endAt: "2026-11-17T17:00:00.000Z",
    purpose: "Site visit",
    destination: "Cikarang",
    passengerCount: 2,
    ...overrides,
  };
}

async function createProvider() {
  const api = makeMockApi();
  const provider = new AddInDataBookingDataProvider(api, DEFAULT_ADDIN_ID);
  return { provider, api };
}

/*───────────────────── Regression Tests ─────────────────────*/

test("create → read → approve resolves by server record ID", async () => {
  const { provider, api } = await createProvider();
  const created = await provider.createBooking(baseBookingInput());
  assert.ok(created.id);
  assert.ok(created.id.startsWith("rec-"), `Expected server record ID, got ${created.id}`);

  // Approve uses the server record ID returned from createBooking
  await provider.updateBookingStatus(created.id, "APPROVED", created.version, "u102");

  // Verify Set used the server record ID (rec-N), not the client booking id
  const setCalls = api.calls.filter(c => c.method === "Set");
  assert.ok(setCalls.length > 0, "Set should be called for status update");
  const lastSet = setCalls[setCalls.length - 1];
  assert.ok(lastSet.params.entity.id.startsWith("rec-"), `Set should use server record ID, got ${lastSet.params.entity.id}`);
  assert.equal(lastSet.params.entity.id, created.id);
});

test("create → read → reject resolves by server record ID", async () => {
  const { provider, api } = await createProvider();
  const created = await provider.createBooking(baseBookingInput());
  await provider.updateBookingStatus(created.id, "REJECTED", created.version, "u102", "Not approved");

  const setCalls = api.calls.filter(c => c.method === "Set");
  assert.ok(setCalls.length > 0);
  const lastSet = setCalls[setCalls.length - 1];
  assert.equal(lastSet.params.entity.id, created.id);
});

test("create → read → complete resolves by server record ID", async () => {
  const { provider, api } = await createProvider();
  const created = await provider.createBooking(baseBookingInput());
  await provider.updateBookingStatus(created.id, "ASSIGNED", created.version, "u102");
  await provider.updateBookingStatus(created.id, "COMPLETED", created.version + 1, "u102");

  const setCalls = api.calls.filter(c => c.method === "Set");
  assert.ok(setCalls.length >= 2);
  const lastSet = setCalls[setCalls.length - 1];
  assert.equal(lastSet.params.entity.id, created.id);
});

test("create → read → cancel resolves by server record ID", async () => {
  const { provider, api } = await createProvider();
  const created = await provider.createBooking(baseBookingInput());
  await provider.updateBookingStatus(created.id, "CANCELLED", created.version, "u102");

  const setCalls = api.calls.filter(c => c.method === "Set");
  assert.ok(setCalls.length > 0);
  const lastSet = setCalls[setCalls.length - 1];
  assert.equal(lastSet.params.entity.id, created.id);
});

test("lookup by server record ID (record.id === bookingId)", async () => {
  const { provider, api } = await createProvider();
  const created = await provider.createBooking(baseBookingInput());
  // Server record ID is rec-1
  assert.ok(created.id.startsWith("rec-"));

  // Direct server ID match should find the record
  await provider.updateBookingStatus(created.id, "APPROVED", created.version, "u102");
  const setCalls = api.calls.filter(c => c.method === "Set");
  assert.equal(setCalls[setCalls.length - 1].params.entity.id, created.id);
});

test("lookup by application ID stored in details (legacy records)", async () => {
  const { provider, api } = await createProvider();
  const created = await provider.createBooking(baseBookingInput());

  // The stored record has details.id = client-generated addin-<ts>, but
  // createBooking overwrites booking.id with the server rec-N id.
  // Simulate a legacy record where the app-level id differs from record.id:
  // Pre-insert a record directly with details.id as the app id.
  const clientId = "addin-legacy-1234567890";
  api.call("Add", {
    typeName: "AddInData",
    entity: {
      addInId: "addin-test-id",
      details: { ...baseBookingInput(), id: clientId, status: "PENDING_APPROVAL" },
      groups: [{ id: "GroupCompanyId" }],
    },
  }, () => {}, () => {});

  // Lookup by application ID stored in details should resolve the record
  await provider.updateBookingStatus(clientId, "APPROVED", 0, "u102");

  const setCalls = api.calls.filter(c => c.method === "Set");
  assert.ok(setCalls.length > 0);
  const lastSet = setCalls[setCalls.length - 1];
  // Set should use the server record ID, not the client id
  assert.ok(lastSet.params.entity.id.startsWith("rec-"), `Set should use server record ID, got ${lastSet.params.entity.id}`);
  assert.notEqual(lastSet.params.entity.id, clientId);
});

test("missing record throws BOOKING_NOT_FOUND", async () => {
  const { provider } = await createProvider();
  await assert.rejects(
    () => provider.updateBookingStatus("rec-nonexistent", "APPROVED", 0, "u102"),
    /BOOKING_NOT_FOUND: rec-nonexistent/
  );
  await assert.rejects(
    () => provider.updateBookingStatus("addin-nonexistent", "APPROVED", 0, "u102"),
    /BOOKING_NOT_FOUND: addin-nonexistent/
  );
});

test("malformed details do not crash lookup", async () => {
  const { provider, api } = await createProvider();
  const created = await provider.createBooking(baseBookingInput());

  // Insert a record with malformed details
  api.call("Add", {
    typeName: "AddInData",
    entity: {
      addInId: "addin-test-id",
      details: "{ not valid json",
      groups: [{ id: "GroupCompanyId" }],
    },
  }, () => {}, () => {});

  // Lookup by server record ID should still work despite malformed record
  await provider.updateBookingStatus(created.id, "APPROVED", created.version, "u102");
  const setCalls = api.calls.filter(c => c.method === "Set");
  assert.equal(setCalls[setCalls.length - 1].params.entity.id, created.id);
});

test("Set operation uses actual server record ID, not application id", async () => {
  const { provider, api } = await createProvider();
  const created = await provider.createBooking(baseBookingInput());

  // Insert a legacy record where details.id != record.id
  const clientId = "addin-legacy-999";
  api.call("Add", {
    typeName: "AddInData",
    entity: {
      addInId: "addin-test-id",
      details: { ...baseBookingInput(), id: clientId, status: "PENDING_APPROVAL" },
      groups: [{ id: "GroupCompanyId" }],
    },
  }, () => {}, () => {});

  await provider.updateBookingStatus(clientId, "APPROVED", 0, "u102");

  const setCalls = api.calls.filter(c => c.method === "Set");
  const lastSet = setCalls[setCalls.length - 1];
  // The Set entity.id must be the server record ID (rec-N), not the client id
  assert.ok(lastSet.params.entity.id.startsWith("rec-"), `Set entity.id should be server record ID, got ${lastSet.params.entity.id}`);
  assert.notEqual(lastSet.params.entity.id, clientId);
});

test("no duplicate booking created during status update", async () => {
  const { provider, api } = await createProvider();
  const created = await provider.createBooking(baseBookingInput());
  const addCallsBefore = api.calls.filter(c => c.method === "Add").length;

  await provider.updateBookingStatus(created.id, "APPROVED", created.version, "u102");

  const addCallsAfter = api.calls.filter(c => c.method === "Add").length;
  assert.equal(addCallsAfter, addCallsBefore, "No additional Add calls during status update");

  const setCalls = api.calls.filter(c => c.method === "Set");
  assert.ok(setCalls.length > 0, "Set should be called exactly for the update");
});

test("deleteBooking resolves by server record ID", async () => {
  const { provider, api } = await createProvider();
  const created = await provider.createBooking(baseBookingInput());

  await provider.deleteBooking(created.id);

  const removeCalls = api.calls.filter(c => c.method === "Remove");
  assert.ok(removeCalls.length > 0);
  assert.equal(removeCalls[removeCalls.length - 1].params.entity.id, created.id);
});

test("deleteBooking resolves by application ID stored in details", async () => {
  const { provider, api } = await createProvider();
  const clientId = "addin-legacy-delete";
  api.call("Add", {
    typeName: "AddInData",
    entity: {
      addInId: "addin-test-id",
      details: { ...baseBookingInput(), id: clientId, status: "PENDING_APPROVAL" },
      groups: [{ id: "GroupCompanyId" }],
    },
  }, () => {}, () => {});

  await provider.deleteBooking(clientId);

  const removeCalls = api.calls.filter(c => c.method === "Remove");
  assert.ok(removeCalls.length > 0);
  assert.ok(removeCalls[removeCalls.length - 1].params.entity.id.startsWith("rec-"), `Remove should use server record ID`);
  assert.notEqual(removeCalls[removeCalls.length - 1].params.entity.id, clientId);
});

test("audit actor attribution remains correct", async () => {
  const { provider, api } = await createProvider();
  const created = await provider.createBooking(baseBookingInput());
  const approverId = "u102";

  await provider.updateBookingStatus(created.id, "APPROVED", created.version, approverId);

  // Verify the booking was updated (not duplicated) and the Set included
  // the approver attribution in details
  const setCalls = api.calls.filter(c => c.method === "Set");
  const lastSet = setCalls[setCalls.length - 1];
  const details = lastSet.params.entity.details;
  assert.equal(details.approverId, approverId);
  assert.equal(details.status, "APPROVED");
});

test("createBooking persists server record id in details (reference sharing)", async () => {
  const { provider, api } = await createProvider();
  const created = await provider.createBooking(baseBookingInput());

  // serializeBooking returns the same object reference, and booking.id is
  // overwritten with the server record ID after Add. So details.id should
  // match the returned server record ID, not the client-generated id.
  const addCalls = api.calls.filter(c => c.method === "Add");
  assert.ok(addCalls.length > 0);
  const lastAdd = addCalls[addCalls.length - 1];
  const details = lastAdd.params.entity.details;
  assert.equal(details.id, created.id, `details.id should equal server record ID ${created.id}, got ${details.id}`);
  assert.ok(created.id.startsWith("rec-"), `Returned booking id should be server record ID rec-N, got ${created.id}`);
});
