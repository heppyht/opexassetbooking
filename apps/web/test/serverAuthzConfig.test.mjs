/*───────────────────── Server Authorization Configuration Tests ─────────────────────*/
/* Regression tests for Phase 24.2: the frontend must read the shared
   `VITE_API_BASE_URL` build-time variable (the same one set by
   .github/workflows/deploy-pages.yml) and must fail closed when it is missing.

   These are UNIT tests. They never contact a real Worker: `fetch` is stubbed.
   Covered behaviors:
     1. `VITE_API_BASE_URL` correctly initializes ServerAuthzClient.
     2. Missing / empty / blank `VITE_API_BASE_URL` leaves the client uninitialized.
     3. Authorization operations fail safely when the Worker URL is missing.
     4. No fallback bypasses server-side authorization (deny/error => abort,
        and no direct AddInData write path is reachable from the gate). */

import test from "node:test";
import assert from "node:assert/strict";
import {
  ServerAuthzClient,
  resolveAuthzBaseUrl,
  createServerAuthzClient,
  authorizeServerAction,
} from "../src/auth/serverAuthzClient.ts";

/*───────────────────── Helpers ─────────────────────*/

function withFetchStub(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    };
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      globalThis.fetch = original;
    });
}

function creds(overrides = {}) {
  return {
    sessionId: "session-abc",
    database: "opex_trial",
    server: "my.geotab.com",
    ...overrides,
  };
}

/*───────────────────── 1. VITE_API_BASE_URL initializes the client ─────────────────────*/

test("authzConfig: VITE_API_BASE_URL initializes a ServerAuthzClient", () => {
  const baseUrl = resolveAuthzBaseUrl({ VITE_API_BASE_URL: "https://opex-vbm-api.example.workers.dev" });
  assert.equal(baseUrl, "https://opex-vbm-api.example.workers.dev");

  const client = createServerAuthzClient(baseUrl);
  assert.ok(client instanceof ServerAuthzClient);
  assert.equal(client instanceof ServerAuthzClient, true);
});

test("authzConfig: resolved base URL is used for Worker requests", async () => {
  const baseUrl = resolveAuthzBaseUrl({ VITE_API_BASE_URL: "  https://api.example.com  " });
  // Surrounding whitespace is trimmed so requests are not sent to a malformed URL.
  assert.equal(baseUrl, "https://api.example.com");

  await withFetchStub(async (calls) => {
    const client = createServerAuthzClient(baseUrl);
    assert.ok(client instanceof ServerAuthzClient);
    await client.verifySession("sid", "opex_trial", "my.geotab.com");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.example.com/authz/verify");
    assert.equal(calls[0].init.method, "POST");
  });
});

/*───────────────────── 2. Missing / empty config leaves client uninitialized ─────────────────────*/

test("authzConfig: missing env object yields empty base URL", () => {
  assert.equal(resolveAuthzBaseUrl(undefined), "");
  assert.equal(resolveAuthzBaseUrl(null), "");
});

test("authzConfig: absent VITE_API_BASE_URL yields empty base URL", () => {
  assert.equal(resolveAuthzBaseUrl({}), "");
  assert.equal(resolveAuthzBaseUrl({ VITE_GEOTAB_DATABASE: "opex_trial" }), "");
});

test("authzConfig: empty / blank / non-string VITE_API_BASE_URL yields empty base URL", () => {
  assert.equal(resolveAuthzBaseUrl({ VITE_API_BASE_URL: "" }), "");
  assert.equal(resolveAuthzBaseUrl({ VITE_API_BASE_URL: "   " }), "");
  assert.equal(resolveAuthzBaseUrl({ VITE_API_BASE_URL: "\t\n" }), "");
  assert.equal(resolveAuthzBaseUrl({ VITE_API_BASE_URL: 123 }), "");
  assert.equal(resolveAuthzBaseUrl({ VITE_API_BASE_URL: null }), "");
  assert.equal(resolveAuthzBaseUrl({ VITE_API_BASE_URL: undefined }), "");
});

test("authzConfig: blank base URL creates no client", () => {
  assert.equal(createServerAuthzClient(""), null);
  assert.equal(createServerAuthzClient("   "), null);
});

test("authzConfig: the legacy VITE_AUTHZ_API_BASE_URL variable is not read", () => {
  // Regression guard for the Phase 24.2 mismatch: only VITE_API_BASE_URL is honored.
  assert.equal(resolveAuthzBaseUrl({ VITE_AUTHZ_API_BASE_URL: "https://legacy.example.com" }), "");
});

/*───────────────────── 3. Fail safe when the Worker URL is missing ─────────────────────*/

test("authzGate: ADDIN_DATA without a client fails closed (SERVER_AUTHZ_NOT_CONFIGURED)", async () => {
  await withFetchStub(async (calls) => {
    await assert.rejects(
      authorizeServerAction({ serverAuthz: null, mode: "ADDIN_DATA", creds: creds(), action: "approve_booking", bookingId: "b1" }),
      /SERVER_AUTHZ_NOT_CONFIGURED/,
    );
    // No request must be attempted when the Worker is not configured.
    assert.equal(calls.length, 0);
  });
});

test("authzGate: ADDIN_DATA without credentials fails closed", async () => {
  await withFetchStub(async () => {
    const client = createServerAuthzClient("https://api.example.com");
    await assert.rejects(
      authorizeServerAction({ serverAuthz: client, mode: "ADDIN_DATA", creds: null, action: "approve_booking", bookingId: "b1" }),
      /SERVER_AUTHZ_NOT_CONFIGURED/,
    );
  });
});

test("authzGate: missing client + missing creds in ADDIN_DATA fails closed", async () => {
  await assert.rejects(
    authorizeServerAction({ serverAuthz: null, mode: "ADDIN_DATA", creds: null, action: "assign_driver" }),
    /SERVER_AUTHZ_NOT_CONFIGURED/,
  );
});

test("authzGate: DEMO mode without server context does not require server authorization", async () => {
  // DEMO uses the local provider only (never live AddInData); no server call is made.
  await withFetchStub(async () => {
    await authorizeServerAction({ serverAuthz: null, mode: "DEMO", creds: null, action: "approve_booking", bookingId: "b1" });
  });
});

/*───────────────────── 4. No fallback bypasses server-side authorization ─────────────────────*/

test("authzGate: Worker denial aborts the operation (NOT_AUTHORIZED)", async () => {
  const denyingClient = {
    authorize: async () => ({ authorized: false, error: "FORBIDDEN", reason: "INSUFFICIENT_ROLE", requiredRole: "APPROVER" }),
  };
  await assert.rejects(
    authorizeServerAction({ serverAuthz: denyingClient, mode: "ADDIN_DATA", creds: creds(), action: "approve_booking", bookingId: "b1" }),
    /NOT_AUTHORIZED: FORBIDDEN/,
  );
});

test("authzGate: Worker error propagates (fail closed, no persistence)", async () => {
  const erroringClient = {
    authorize: async () => {
      throw new Error("WORKER_UNAVAILABLE");
    },
  };
  await assert.rejects(
    authorizeServerAction({ serverAuthz: erroringClient, mode: "ADDIN_DATA", creds: creds(), action: "approve_booking", bookingId: "b1" }),
    /WORKER_UNAVAILABLE/,
  );
});

test("authzGate: Worker approval resolves the gate", async () => {
  let received = null;
  const allowingClient = {
    authorize: async (sessionId, database, server, action, bookingId) => {
      received = { sessionId, database, server, action, bookingId };
      return { authorized: true, principal: { userName: "jdoe", roles: ["APPROVER"] }, requiredRole: "APPROVER" };
    },
  };
  await authorizeServerAction({
    serverAuthz: allowingClient,
    mode: "ADDIN_DATA",
    creds: creds(),
    action: "approve_booking",
    bookingId: "b1",
  });
  assert.deepEqual(received, {
    sessionId: "session-abc",
    database: "opex_trial",
    server: "my.geotab.com",
    action: "approve_booking",
    bookingId: "b1",
  });
});

test("authzGate: denial error does not leak session IDs or credentials", async () => {
  const secretSession = "SESSION-TOP-SECRET";
  const secretDb = "SECRET_DB";
  const secretServer = "secret-server.internal";
  const denyingClient = {
    authorize: async () => ({ authorized: false, error: "FORBIDDEN", reason: "INSUFFICIENT_ROLE" }),
  };
  await assert.rejects(
    authorizeServerAction({
      serverAuthz: denyingClient,
      mode: "ADDIN_DATA",
      creds: creds({ sessionId: secretSession, database: secretDb, server: secretServer }),
      action: "approve_booking",
      bookingId: "b1",
    }),
    (err) => {
      assert.ok(!err.message.includes(secretSession), "session id must not appear in error");
      assert.ok(!err.message.includes(secretDb), "database must not appear in error");
      assert.ok(!err.message.includes(secretServer), "server must not appear in error");
      return true;
    },
  );
});