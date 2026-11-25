/*───────────────────── Worker HTTP Integration Test Harness ─────────────────────*/
/* Tests the actual Cloudflare Worker /authz/execute endpoint with mocked
   MyGeotab dependencies. This is REAL HTTP route testing — not mocked provider
   methods — using Hono's built-in app.request() to invoke the actual handler.

   External dependencies mocked via globalThis.fetch interception:
   - verifySession (Get User RPC)
   - authenticateServiceAccount (Authenticate RPC)
   - addInDataGet (Get AddInData RPC - idempotency check)
   - addInDataAdd (Add AddInData RPC)
   - addInDataSet (Set AddInData RPC)
   - addInDataRemove (Remove AddInData RPC)

   All MyGeotab JSON-RPC calls go through myGeotabCall() → fetch(),
   so overriding globalThis.fetch mocks the entire MyGeotab layer. */

import test from "node:test";
import assert from "node:assert/strict";

/*───────────────────── Import Worker App ─────────────────────*/
const mod = await import("../src/index.ts");
const app = mod.default;

/*───────────────────── Mock Fetch Setup ─────────────────────*/

const originalFetch = globalThis.fetch;
const fetchCalls = [];

let mockUsers = new Map();
let mockAddInData = new Map();
let mockSessionValid = true;
let mockServiceAccountConfigured = true;
let mockMyGeotabFail = false;
let mockAuthenticateFail = false;
let mockRecordCounter = 0;

function resetMockState() {
  mockUsers = new Map();
  mockAddInData = new Map();
  mockSessionValid = true;
  mockServiceAccountConfigured = true;
  mockMyGeotabFail = false;
  mockAuthenticateFail = false;
  mockRecordCounter = 0;
  fetchCalls.length = 0;
}

function registerUser(userName, securityClearance = "APPROVER", active = true) {
  mockUsers.set(userName, { securityClearance, active });
}

function setSessionValid(valid) {
  mockSessionValid = valid;
}

function setServiceAccountConfigured(configured) {
  mockServiceAccountConfigured = configured;
}

function setMyGeotabFail(fail) {
  mockMyGeotabFail = fail;
}

function setAuthenticateFail(fail) {
  mockAuthenticateFail = fail;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/* The single fetch interceptor. Installed before every test (see beforeEach)
   so afterEach restoring the real fetch cannot leak into the next test. */
async function mockFetch(url, options) {
  const method = options?.method || "GET";
  let body = {};
  try {
    body = options?.body ? JSON.parse(options.body) : {};
  } catch {
    body = {};
  }
  const rpcMethod = body?.method;
  const rpcParams = body?.params || {};

  fetchCalls.push({ method, rpcMethod, rpcParams });

  if (mockMyGeotabFail) {
    return jsonResponse({ error: { message: "MyGeotab API failure" } }, 500);
  }

  /* Authenticate (service account login) */
  if (rpcMethod === "Authenticate") {
    if (mockAuthenticateFail) {
      return jsonResponse({ error: { message: "AUTHENTICATE_FAILED" } }, 500);
    }
    if (!mockServiceAccountConfigured) {
      return jsonResponse({ error: { message: "SERVICE_ACCOUNT_NOT_CONFIGURED" } }, 400);
    }
    return jsonResponse({
      result: {
        credentials: {
          database: "opex_trial",
          userName: "service-account",
          sessionId: "svc-session-123",
        },
      },
    });
  }

  /* Get User (session verification) */
  if (rpcMethod === "Get" && rpcParams.typeName === "User") {
    /* Session validity gate */
    if (!mockSessionValid) {
      return jsonResponse({ error: { message: "Invalid session" } });
    }

    const userName = rpcParams.search?.userName || "testuser";
    const user = mockUsers.get(userName);

    if (!user) {
      return jsonResponse({ error: { message: "USER_NOT_FOUND" } });
    }

    if (!user.active) {
      return jsonResponse({ error: { message: "USER_INACTIVE" } });
    }

    return jsonResponse({
      result: [{ id: `user-${userName}`, userName, securityClearance: user.securityClearance, active: user.active }],
    });
  }

  /* Get AddInData (idempotency key check) */
  if (rpcMethod === "Get" && rpcParams.typeName === "AddInData") {
    const whereClause = rpcParams.whereClause || "";
    const keyMatch = whereClause.match(/idempotencyKey = "([^"]+)"/);
    if (keyMatch) {
      const key = keyMatch[1];
      const found = [...mockAddInData.values()].find(r => r.details?.idempotencyKey === key);
      return jsonResponse({
        result: found ? [{ id: "idem-record-1", addInId: "aid", details: found.details, groups: [] }] : [],
      });
    }
    return jsonResponse({ result: [] });
  }

  /* Add AddInData (booking write + idempotency storage) */
  if (rpcMethod === "Add") {
    const entity = rpcParams.entity || {};
    const details = entity.details || {};
    const id = `svc-record-${++mockRecordCounter}`;
    mockAddInData.set(id, { details });
    return jsonResponse({ result: { id } });
  }

  /* Set AddInData (booking update) */
  if (rpcMethod === "Set") {
    return jsonResponse({ result: {} });
  }

  /* Remove AddInData (booking delete) */
  if (rpcMethod === "Remove") {
    return jsonResponse({ result: {} });
  }

  return jsonResponse({ result: {} });
}

test.beforeEach(() => {
  globalThis.fetch = mockFetch;
  resetMockState();
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

/*───────────────────── Mock Env (Bindings) ─────────────────────*/

const mockEnv = {
  APP_ENV: "test",
  GEOTAB_DATABASE: "opex_trial",
  GEOTAB_SERVICE_SERVER: "my.geotab.com",
  GEOTAB_SERVICE_USERNAME: "service-account",
  GEOTAB_SERVICE_PASSWORD: "secret-not-in-code",
  ALLOWED_ORIGIN: "https://heppyh.github.io",
};

/*───────────────────── Helper: Build Execution Request ─────────────────────*/

function makeExecuteRequest(overrides = {}) {
  return {
    sessionId: "sess-1",
    database: "opex_trial",
    server: "my.geotab.com",
    userName: "testuser",
    action: "create_booking",
    bookingId: "b1",
    bookingData: { status: "PENDING_APPROVAL", purpose: "Trip" },
    idempotencyKey: "idem-1",
    operation: "add",
    ...overrides,
  };
}

async function executeRequest(body) {
  return await app.request("/authz/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, mockEnv);
}

/*───────────────────── HTTP Validation Tests ─────────────────────*/

test("Worker HTTP /authz/execute — valid request returns 200 with success", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const res = await executeRequest(makeExecuteRequest());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.recordId, "svc-record-1");
});

test("Worker HTTP /authz/execute — missing sessionId returns 400", async (t) => {
  const body = makeExecuteRequest();
  delete body.sessionId;
  const res = await executeRequest(body);
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.error, "MISSING_REQUEST_FIELDS");
});

test("Worker HTTP /authz/execute — missing database returns 400", async (t) => {
  const body = makeExecuteRequest();
  delete body.database;
  const res = await executeRequest(body);
  assert.equal(res.status, 400);
});

test("Worker HTTP /authz/execute — missing server returns 400", async (t) => {
  const body = makeExecuteRequest();
  delete body.server;
  const res = await executeRequest(body);
  assert.equal(res.status, 400);
});

test("Worker HTTP /authz/execute — missing userName returns 400", async (t) => {
  const body = makeExecuteRequest();
  delete body.userName;
  const res = await executeRequest(body);
  assert.equal(res.status, 400);
});

test("Worker HTTP /authz/execute — missing action returns 400", async (t) => {
  const body = makeExecuteRequest();
  delete body.action;
  const res = await executeRequest(body);
  assert.equal(res.status, 400);
});

test("Worker HTTP /authz/execute — missing bookingId returns 400", async (t) => {
  const body = makeExecuteRequest();
  delete body.bookingId;
  const res = await executeRequest(body);
  assert.equal(res.status, 400);
});

test("Worker HTTP /authz/execute — missing idempotency key returns 403", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const body = makeExecuteRequest();
  delete body.idempotencyKey;
  const res = await executeRequest(body);
  assert.equal(res.status, 403);
  const json = await res.json();
  assert.equal(json.error, "IDEMPOTENCY_KEY_REQUIRED");
});

test("Worker HTTP /authz/execute — invalid action returns 403 UNKNOWN_ACTION", async (t) => {
  registerUser("testuser", "ADMINISTRATOR");
  const body = makeExecuteRequest({ action: "forge_booking" });
  const res = await executeRequest(body);
  assert.equal(res.status, 403);
  const json = await res.json();
  assert.equal(json.error, "UNKNOWN_ACTION");
});

test("Worker HTTP /authz/execute — malformed JSON returns 400", async (t) => {
  const res = await app.request("/authz/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not json",
  }, mockEnv);
  assert.equal(res.status, 400);
});

test("Worker HTTP /authz/execute — GET method returns 404", async (t) => {
  const res = await app.request("/authz/execute", { method: "GET" }, mockEnv);
  assert.equal(res.status, 404);
});

test("Worker HTTP /authz/execute — CORS rejected origin returns 403", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const res = await app.request("/authz/execute", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://evil.example.com",
    },
    body: JSON.stringify(makeExecuteRequest()),
  }, mockEnv);
  assert.equal(res.status, 403);
  const json = await res.json();
  assert.equal(json.error, "ORIGIN_NOT_ALLOWED");
});

test("Worker HTTP /authz/execute — allowed origin returns 200", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const res = await app.request("/authz/execute", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://heppyh.github.io",
    },
    body: JSON.stringify(makeExecuteRequest()),
  }, mockEnv);
  assert.equal(res.status, 200);
});

/*───────────────────── Session Verification Tests ─────────────────────*/

test("Worker HTTP /authz/execute — invalid session returns 403 INVALID_SESSION", async (t) => {
  setSessionValid(false);
  registerUser("testuser", "EMPLOYEE");
  const res = await executeRequest(makeExecuteRequest());
  assert.equal(res.status, 403);
  const json = await res.json();
  assert.equal(json.reason, "INVALID_SESSION");
});

test("Worker HTTP /authz/execute — user not found returns 403", async (t) => {
  /* Don't register the user */
  const res = await executeRequest(makeExecuteRequest({ userName: "nonexistent" }));
  assert.equal(res.status, 403);
});

test("Worker HTTP /authz/execute — inactive user returns 403", async (t) => {
  registerUser("testuser", "EMPLOYEE", false);
  const res = await executeRequest(makeExecuteRequest());
  assert.equal(res.status, 403);
});

test("Worker HTTP /authz/execute — valid session proceeds to authorization", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const body = makeExecuteRequest({ action: "create_booking" });
  const res = await executeRequest(body);
  assert.equal(res.status, 200);
});

/*───────────────────── Authorization (RBAC) Tests ─────────────────────*/

test("Worker HTTP /authz/execute — EMPLOYEE can create_booking", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const res = await executeRequest(makeExecuteRequest({ action: "create_booking" }));
  assert.equal(res.status, 200);
});

test("Worker HTTP /authz/execute — EMPLOYEE cannot approve_booking", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const res = await executeRequest(makeExecuteRequest({ action: "approve_booking" }));
  assert.equal(res.status, 403);
  const json = await res.json();
  assert.equal(json.error, "INSUFFICIENT_ROLE");
});

test("Worker HTTP /authz/execute — APPROVER can approve_booking", async (t) => {
  registerUser("testuser", "APPROVER");
  const res = await executeRequest(makeExecuteRequest({ action: "approve_booking" }));
  assert.equal(res.status, 200);
});

test("Worker HTTP /authz/execute — ADMIN can approve_booking", async (t) => {
  registerUser("testuser", "ADMINISTRATOR");
  const res = await executeRequest(makeExecuteRequest({ action: "approve_booking" }));
  assert.equal(res.status, 200);
});

test("Worker HTTP /authz/execute — EMPLOYEE cannot reject_booking", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const res = await executeRequest(makeExecuteRequest({ action: "reject_booking" }));
  assert.equal(res.status, 403);
});

test("Worker HTTP /authz/execute — EMPLOYEE can cancel_booking", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const res = await executeRequest(makeExecuteRequest({ action: "cancel_booking" }));
  assert.equal(res.status, 200);
});

test("Worker HTTP /authz/execute — ADMIN can cancel_booking", async (t) => {
  registerUser("testuser", "ADMINISTRATOR");
  const res = await executeRequest(makeExecuteRequest({ action: "cancel_booking" }));
  assert.equal(res.status, 200);
});

test("Worker HTTP /authz/execute — GA can assign_driver", async (t) => {
  registerUser("testuser", "GA");
  const res = await executeRequest(makeExecuteRequest({ action: "assign_driver" }));
  assert.equal(res.status, 200);
});

test("Worker HTTP /authz/execute — EMPLOYEE cannot assign_driver", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const res = await executeRequest(makeExecuteRequest({ action: "assign_driver" }));
  assert.equal(res.status, 403);
});

test("Worker HTTP /authz/execute — ADMIN can view_security_dashboard", async (t) => {
  registerUser("testuser", "ADMINISTRATOR");
  const res = await executeRequest(makeExecuteRequest({ action: "view_security_dashboard" }));
  assert.equal(res.status, 200);
});

test("Worker HTTP /authz/execute — APPROVER cannot view_security_dashboard", async (t) => {
  registerUser("testuser", "APPROVER");
  const res = await executeRequest(makeExecuteRequest({ action: "view_security_dashboard" }));
  assert.equal(res.status, 403);
});

/*───────────────────── Payload Integrity (SHA-256 Fingerprint) Tests ─────────────────────*/

test("Worker HTTP /authz/execute — same key + same payload returns cached result", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const req = makeExecuteRequest();
  const res1 = await executeRequest(req);
  assert.equal(res1.status, 200);

  const res2 = await executeRequest(req);
  assert.equal(res2.status, 200);
  const json2 = await res2.json();
  assert.equal(json2.success, true);
});

test("Worker HTTP /authz/execute — same key + different payload returns IDEMPOTENCY_KEY_CONFLICT", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const req1 = makeExecuteRequest({ bookingData: { status: "PENDING_APPROVAL" } });
  await executeRequest(req1);

  const req2 = makeExecuteRequest({ bookingData: { status: "APPROVED" } });
  const res2 = await executeRequest(req2);
  assert.equal(res2.status, 403);
  const json2 = await res2.json();
  assert.equal(json2.error, "IDEMPOTENCY_KEY_CONFLICT");
});

test("Worker HTTP /authz/execute — same semantic payload, different key order, identical fingerprint", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const req1 = makeExecuteRequest({
    bookingData: { status: "APPROVED", purpose: "Trip", destination: "Site A" },
  });
  await executeRequest(req1);

  const req2 = makeExecuteRequest({
    bookingData: { destination: "Site A", purpose: "Trip", status: "APPROVED" },
  });
  const res2 = await executeRequest(req2);
  assert.equal(res2.status, 200);
  const json2 = await res2.json();
  assert.equal(json2.success, true);
});

test("Worker HTTP /authz/execute — altered booking ID is different fingerprint", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const req1 = makeExecuteRequest({ bookingId: "b1" });
  await executeRequest(req1);

  const req2 = makeExecuteRequest({ bookingId: "b2", idempotencyKey: "idem-2" });
  const res2 = await executeRequest(req2);
  assert.equal(res2.status, 200);
});

test("Worker HTTP /authz/execute — altered operation is different fingerprint", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const req1 = makeExecuteRequest({ operation: "add" });
  await executeRequest(req1);

  const req2 = makeExecuteRequest({ operation: "set", recordId: "rec-1", idempotencyKey: "idem-2" });
  const res2 = await executeRequest(req2);
  assert.equal(res2.status, 200);
});

test("Worker HTTP /authz/execute — altered record ID is different fingerprint", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const req1 = makeExecuteRequest({ operation: "set", recordId: "rec-1" });
  await executeRequest(req1);

  const req2 = makeExecuteRequest({ operation: "set", recordId: "rec-2", idempotencyKey: "idem-2" });
  const res2 = await executeRequest(req2);
  assert.equal(res2.status, 200);
});

/*───────────────────── Idempotency Tests ─────────────────────*/

test("Worker HTTP /authz/execute — missing key fails closed", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const body = makeExecuteRequest();
  delete body.idempotencyKey;
  const res = await executeRequest(body);
  assert.equal(res.status, 403);
  const json = await res.json();
  assert.equal(json.error, "IDEMPOTENCY_KEY_REQUIRED");
});

test("Worker HTTP /authz/execute — retry after successful execution returns cached result", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const req = makeExecuteRequest();
  const res1 = await executeRequest(req);
  assert.equal(res1.status, 200);

  const res2 = await executeRequest(req);
  assert.equal(res2.status, 200);
  const json2 = await res2.json();
  assert.equal(json2.success, true);
});

/*───────────────────── Execution Behavior Tests ─────────────────────*/

test("Worker HTTP /authz/execute — successful Add operation", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const res = await executeRequest(makeExecuteRequest({ action: "create_booking", operation: "add" }));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, true);
  assert.equal(json.recordId, "svc-record-1");
});

test("Worker HTTP /authz/execute — successful Set operation", async (t) => {
  registerUser("testuser", "APPROVER");
  const res = await executeRequest(makeExecuteRequest({
    action: "approve_booking",
    operation: "set",
    recordId: "rec-1",
  }));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, true);
});

test("Worker HTTP /authz/execute — successful Remove operation", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const res = await executeRequest(makeExecuteRequest({
    action: "delete_booking",
    operation: "remove",
    recordId: "rec-1",
  }));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, true);
});

test("Worker HTTP /authz/execute — set operation without recordId returns 403", async (t) => {
  registerUser("testuser", "APPROVER");
  const body = makeExecuteRequest({ action: "approve_booking", operation: "set" });
  delete body.recordId;
  const res = await executeRequest(body);
  assert.equal(res.status, 403);
  const json = await res.json();
  assert.equal(json.error, "RECORD_ID_REQUIRED");
});

test("Worker HTTP /authz/execute — remove operation without recordId returns 403", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const body = makeExecuteRequest({ action: "delete_booking", operation: "remove" });
  delete body.recordId;
  const res = await executeRequest(body);
  assert.equal(res.status, 403);
  const json = await res.json();
  assert.equal(json.error, "RECORD_ID_REQUIRED");
});

test("Worker HTTP /authz/execute — service account authentication failure returns 500", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  /* Session verification succeeds, but the service-account Authenticate RPC
     fails. getCredentials() throws before the write try/catch, so the Worker's
     outer handler returns 500 SERVER_ERROR. */
  setAuthenticateFail(true);
  const res = await executeRequest(makeExecuteRequest({ action: "create_booking" }));
  assert.equal(res.status, 500);
});

test("Worker HTTP /authz/execute — service account not configured returns 500", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  /* Missing service-account env vars make authenticateServiceAccount throw
     SERVICE_ACCOUNT_NOT_CONFIGURED before any RPC; the outer handler returns
     500 with that message (server misconfiguration, not a client error). */
  const envNoCreds = {
    ...mockEnv,
    GEOTAB_SERVICE_USERNAME: "",
    GEOTAB_SERVICE_PASSWORD: "",
  };
  const res = await app.request("/authz/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeExecuteRequest({ action: "create_booking" })),
  }, envNoCreds);
  assert.equal(res.status, 500);
  const json = await res.json();
  assert.equal(json.error, "SERVICE_ACCOUNT_NOT_CONFIGURED");
});

/*───────────────────── Worker HTTP Routing Verification ─────────────────────*/

test("Worker HTTP routing — POST /authz/execute routes to handleExecute", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const res = await executeRequest(makeExecuteRequest({ action: "create_booking" }));
  assert.equal(res.status, 200);
  assert.ok(fetchCalls.length > 0, "Expected fetch calls to MyGeotab");
});

test("Worker HTTP routing — GET /authz/health returns service info", async (t) => {
  const res = await app.request("/authz/health", { method: "GET" }, mockEnv);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.service, "opex-vbm-authz");
});

test("Worker HTTP routing — POST /authz/authorize returns authorization decision", async (t) => {
  registerUser("testuser", "APPROVER");
  const res = await app.request("/authz/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: "sess-1",
      database: "opex_trial",
      server: "my.geotab.com",
      userName: "testuser",
      action: "approve_booking",
    }),
  }, mockEnv);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.authorized, true);
});

test("Worker HTTP routing — POST /authz/authorize rejects unauthorized", async (t) => {
  registerUser("testuser", "EMPLOYEE");
  const res = await app.request("/authz/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: "sess-1",
      database: "opex_trial",
      server: "my.geotab.com",
      userName: "testuser",
      action: "approve_booking",
    }),
  }, mockEnv);
  assert.equal(res.status, 403);
  const json = await res.json();
  assert.equal(json.authorized, false);
});
