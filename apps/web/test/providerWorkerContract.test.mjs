/*───────────────────── Provider → Worker Contract Integration ─────────────────────*/
/* Exercises the REAL Cloudflare Worker HTTP handler (apps/api/src/index.ts) via
   app.request(), with only the MyGeotab RPC layer mocked at globalThis.fetch.
   The AddInDataBookingDataProvider is constructed with a real ServerAuthzClient
   pointed at an in-process Worker base URL, so protected writes travel the full
   provider → /authz/execute → verifySession → RBAC → idempotency → fingerprint →
   AddInData path. This is the test that catches provider/Worker contract drift
   (action names, idempotency key, operation/recordId). */

import test from "node:test";
import assert from "node:assert/strict";

const workerMod = await import("../../api/src/index.ts");
const app = workerMod.default;
const { AddInDataBookingDataProvider } = await import("../src/data/addinDataProvider.ts");
const { ServerAuthzClient } = await import("../src/auth/serverAuthzClient.ts");

const WORKER_BASE = "https://worker.test";
const originalFetch = globalThis.fetch;

const mockEnv = {
  APP_ENV: "test",
  GEOTAB_DATABASE: "opex_trial",
  GEOTAB_SERVICE_SERVER: "my.geotab.com",
  GEOTAB_SERVICE_USERNAME: "service-account",
  GEOTAB_SERVICE_PASSWORD: "secret-not-in-code",
  ALLOWED_ORIGIN: "https://heppyh.github.io",
};

let mockUsers = new Map();
let mockAddInData = new Map();
let mockRecordCounter = 0;
let workerRequests = [];

function resetMockState() {
  mockUsers = new Map();
  mockAddInData = new Map();
  mockRecordCounter = 0;
  workerRequests = [];
}

function registerUser(userName, securityClearance, active = true) {
  mockUsers.set(userName, { securityClearance, active });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

async function mockFetch(url, options) {
  const u = String(url);
  const method = options?.method || "GET";

  /* Provider → Worker */
  if (u.startsWith(WORKER_BASE)) {
    const path = u.slice(WORKER_BASE.length);
    let parsed = {};
    try { parsed = options?.body ? JSON.parse(options.body) : {}; } catch { parsed = {}; }
    workerRequests.push({ path, body: parsed });
    return app.request(path, {
      method,
      headers: options?.headers || { "Content-Type": "application/json" },
      body: options?.body,
    }, mockEnv);
  }

  /* MyGeotab RPC */
  let body = {};
  try { body = options?.body ? JSON.parse(options.body) : {}; } catch { body = {}; }
  const rpcMethod = body?.method;
  const rpcParams = body?.params || {};

  if (rpcMethod === "Authenticate") {
    return jsonResponse({ result: { credentials: { database: "opex_trial", userName: "service-account", sessionId: "svc-session-123" } } });
  }
  if (rpcMethod === "Get" && rpcParams.typeName === "User") {
    const userName = rpcParams.search?.userName || "testuser";
    const user = mockUsers.get(userName);
    if (!user) return jsonResponse({ error: { message: "USER_NOT_FOUND" } });
    if (!user.active) return jsonResponse({ error: { message: "USER_INACTIVE" } });
    return jsonResponse({ result: [{ id: `user-${userName}`, userName, securityClearance: user.securityClearance, active: user.active }] });
  }
  if (rpcMethod === "Get" && rpcParams.typeName === "AddInData") {
    const whereClause = rpcParams.whereClause || "";
    const keyMatch = whereClause.match(/idempotencyKey = "([^"]+)"/);
    if (keyMatch) {
      const key = keyMatch[1];
      const found = [...mockAddInData.values()].find(r => r.details?.idempotencyKey === key);
      return jsonResponse({ result: found ? [{ id: "idem-record-1", addInId: "aid", details: found.details, groups: [] }] : [] });
    }
    return jsonResponse({ result: [] });
  }
  if (rpcMethod === "Add") {
    const id = `svc-record-${++mockRecordCounter}`;
    mockAddInData.set(id, { details: (rpcParams.entity || {}).details || {} });
    return jsonResponse({ result: { id } });
  }
  if (rpcMethod === "Set" || rpcMethod === "Remove") {
    return jsonResponse({ result: {} });
  }
  return jsonResponse({ result: {} });
}

/* Mock GeotabApi for the provider's own reads (findBookingRecord). Get returns
   booking "b1" at version 1; writes are not performed directly. */
function makeMockApi() {
  return {
    call: (method, params, success) => {
      if (method === "Get") {
        success([{
          id: "server-record-b1",
          addInId: params.search?.addInId,
          details: {
            recordType: "booking",
            schemaVersion: 1,
            id: "b1",
            deviceId: "d1",
            requesterUserId: "u1",
            status: "PENDING_APPROVAL",
            startAt: "2026-11-25T08:00:00.000Z",
            endAt: "2026-11-25T09:00:00.000Z",
            purpose: "Existing trip",
            destination: null,
            passengerCount: null,
            version: 1,
          },
          groups: [{ id: "GroupCompanyId" }],
        }]);
      } else {
        success(null);
      }
    },
  };
}

function makeProvider(clearance) {
  registerUser("testuser", clearance);
  const serverAuthz = new ServerAuthzClient({ baseUrl: WORKER_BASE });
  const creds = { sessionId: "sess-1", database: "opex_trial", server: "my.geotab.com", userName: "testuser" };
  return new AddInDataBookingDataProvider(makeMockApi(), "aAAAAAAAAAAAAAAAAAAAAAA", "GroupCompanyId", serverAuthz, creds);
}

test.beforeEach(() => {
  globalThis.fetch = mockFetch;
  resetMockState();
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

/*───────────── Status transition → canonical action (all succeed) ─────────────*/

const TRANSITIONS = [
  ["APPROVED", "approve_booking"],
  ["REJECTED", "reject_booking"],
  ["CANCELLED", "cancel_booking"],
  ["COMPLETED", "complete_booking"],
  ["ASSIGNED", "assign_driver"],
];

for (const [status, expectedAction] of TRANSITIONS) {
  test(`provider→Worker: ${status} sends "${expectedAction}" and succeeds`, async () => {
    const provider = makeProvider("ADMINISTRATOR"); // ADMIN satisfies every required role
    await provider.updateBookingStatus("b1", status, 1, "approver-1");

    const exec = workerRequests.find(r => r.path === "/authz/execute");
    assert.ok(exec, "Worker /authz/execute was called");
    assert.equal(exec.body.action, expectedAction);
    assert.equal(exec.body.operation, "set");
    assert.equal(exec.body.bookingId, "b1");
    assert.ok(exec.body.idempotencyKey, "idempotency key is sent");
  });
}

/*───────────── create_booking / delete_booking ─────────────*/

test("provider→Worker: create_booking sends canonical action and succeeds", async () => {
  const provider = makeProvider("ADMINISTRATOR");
  await provider.createBooking({
    deviceId: "d1",
    requesterUserId: "u1",
    requestedClass: "PASSENGER",
    startAt: "2026-11-20T08:00:00.000Z",
    endAt: "2026-11-20T09:00:00.000Z",
    purpose: "Trip",
    destination: null,
    passengerCount: null,
  });
  const exec = workerRequests.find(r => r.path === "/authz/execute");
  assert.ok(exec);
  assert.equal(exec.body.action, "create_booking");
  assert.equal(exec.body.operation, "add");
  assert.ok(exec.body.idempotencyKey);
});

test("provider→Worker: delete_booking sends canonical action and succeeds", async () => {
  const provider = makeProvider("ADMINISTRATOR");
  await provider.deleteBooking("b1");
  const exec = workerRequests.find(r => r.path === "/authz/execute");
  assert.ok(exec);
  assert.equal(exec.body.action, "delete_booking");
  assert.equal(exec.body.operation, "remove");
  assert.ok(exec.body.idempotencyKey);
});

/*───────────── RBAC is enforced by the real Worker ─────────────*/

test("provider→Worker: EMPLOYEE cannot approve (Worker 403 → rejected)", async () => {
  const provider = makeProvider("EMPLOYEE");
  /* ServerAuthzClient throws ServerAuthzError on the Worker's 403; the write is
     aborted before any AddInData mutation (fail closed). */
  await assert.rejects(
    () => provider.updateBookingStatus("b1", "APPROVED", 1, "approver-1"),
    /INSUFFICIENT_ROLE/,
  );
  const exec = workerRequests.find(r => r.path === "/authz/execute");
  assert.equal(exec.body.action, "approve_booking"); // correct action, denied by role
});

/*───────────── /authz/authorize gate (pre-write) carries userName ─────────────*/

test("provider→Worker: /authz/authorize sends userName and authorizes", async () => {
  registerUser("testuser", "APPROVER");
  const serverAuthz = new ServerAuthzClient({ baseUrl: WORKER_BASE });
  const res = await serverAuthz.authorize("sess-1", "opex_trial", "my.geotab.com", "approve_booking", "b1", "testuser");
  assert.equal(res.authorized, true);
  const authzReq = workerRequests.find(r => r.path === "/authz/authorize");
  assert.ok(authzReq, "Worker /authz/authorize was called");
  assert.equal(authzReq.body.userName, "testuser");
  assert.equal(authzReq.body.action, "approve_booking");
});

/*───────────── Unknown status fails closed (no Worker call) ─────────────*/

test("provider→Worker: unknown status fails closed without calling the Worker", async () => {
  const provider = makeProvider("ADMINISTRATOR");
  await assert.rejects(
    () => provider.updateBookingStatus("b1", "DRAFT", 1, "approver-1"),
    /UNSUPPORTED_STATUS_ACTION/,
  );
  assert.equal(workerRequests.length, 0);
});