/*───────────────────── ExecuteMultiCall Helper Tests ─────────────────────*/
/* Unit tests for executeMultiGet: batching, result ordering, and fallback. */

import test from "node:test";
import assert from "node:assert/strict";
import { executeMultiGet, MAX_MULTI_CALL } from "../src/data/multiCall.ts";

/* Mock that supports ExecuteMultiCall and records calls. */
function makeApi({ batchThrows = false, batchReturns = "ordered" } = {}) {
  const calls = [];
  const datasets = {
    Device: [{ id: "d1" }, { id: "d2" }],
    User: [{ id: "u1" }],
    Group: [{ id: "g1" }],
  };
  const getOne = (typeName) => datasets[typeName] ?? [];

  const api = (method, params, success, error) => {
    calls.push({ method, params });
    if (method === "ExecuteMultiCall") {
      if (batchThrows) return error(new Error("MULTICALL_UNSUPPORTED"));
      const nested = params.calls.map((c) => c.params.typeName);
      if (batchReturns === "null") return success(null);
      if (batchReturns === "wronglength") return success([[{}]]); // wrong length
      return success(nested.map((t) => getOne(t)));
    }
    if (method === "Get") return success(getOne(params.typeName));
    return success(null);
  };
  return { api, calls };
}

test("multiCall: batches independent Gets into one ExecuteMultiCall", async () => {
  const { api, calls } = makeApi();
  const results = await executeMultiGet(api, [
    { typeName: "Device" },
    { typeName: "User" },
    { typeName: "Group" },
  ]);

  const batchCalls = calls.filter((c) => c.method === "ExecuteMultiCall");
  assert.equal(batchCalls.length, 1, "Should issue exactly one ExecuteMultiCall");
  assert.equal(batchCalls[0].params.calls.length, 3, "Should nest 3 Get requests");
  // Results preserved in request order.
  assert.equal(results[0].length, 2);
  assert.equal(results[1].length, 1);
  assert.equal(results[2].length, 1);
  assert.deepEqual(results[1], [{ id: "u1" }]);
});

test("multiCall: result ordering matches request order", async () => {
  const { api } = makeApi();
  const results = await executeMultiGet(api, [
    { typeName: "User" },
    { typeName: "Device" },
  ]);
  assert.deepEqual(results[0], [{ id: "u1" }]);
  assert.deepEqual(results[1], [{ id: "d1" }, { id: "d2" }]);
});

test("multiCall: falls back to individual Gets when ExecuteMultiCall throws", async () => {
  const { api, calls } = makeApi({ batchThrows: true });
  const results = await executeMultiGet(api, [
    { typeName: "Device" },
    { typeName: "User" },
  ]);

  assert.equal(calls.filter((c) => c.method === "ExecuteMultiCall").length, 1);
  assert.equal(calls.filter((c) => c.method === "Get").length, 2, "Should fall back to 2 individual Gets");
  assert.equal(results[0].length, 2);
  assert.deepEqual(results[1], [{ id: "u1" }]);
});

test("multiCall: falls back when batched result is null", async () => {
  const { api, calls } = makeApi({ batchReturns: "null" });
  const results = await executeMultiGet(api, [{ typeName: "Device" }]);
  assert.equal(calls.filter((c) => c.method === "Get").length, 1);
  assert.equal(results[0].length, 2);
});

test("multiCall: falls back when batched result has wrong length", async () => {
  const { api, calls } = makeApi({ batchReturns: "wronglength" });
  const results = await executeMultiGet(api, [
    { typeName: "Device" },
    { typeName: "User" },
  ]);
  assert.equal(calls.filter((c) => c.method === "Get").length, 2);
  assert.equal(results.length, 2);
});

test("multiCall: null/empty api yields null results without throwing", async () => {
  const results = await executeMultiGet(null, [{ typeName: "Device" }, { typeName: "User" }]);
  assert.deepEqual(results, [null, null]);
});

test("multiCall: more than MAX_MULTI_CALL requests bypasses batching", async () => {
  const { api, calls } = makeApi();
  const requests = Array.from({ length: MAX_MULTI_CALL + 5 }, (_, i) => ({ typeName: i % 2 ? "Device" : "User" }));
  const results = await executeMultiGet(api, requests);
  assert.equal(calls.filter((c) => c.method === "ExecuteMultiCall").length, 0, "Should not batch beyond the limit");
  assert.equal(calls.filter((c) => c.method === "Get").length, MAX_MULTI_CALL + 5);
  assert.equal(results.length, MAX_MULTI_CALL + 5);
});