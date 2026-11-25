/*───────────────────── Service Add-In Polling Tests ─────────────────────*/
/* Unit tests for the overlap guard and backoff helpers exported by the
   Service Add-In (self-contained for the standalone `--module None` build). */

import test from "node:test";
import assert from "node:assert/strict";
import { createOverlapGuard, computeBackoffMs } from "../src/serviceAddin.ts";

test("serviceAddin overlap guard: prevents overlapping notification polls", async () => {
  const guard = createOverlapGuard();
  let concurrent = 0;
  let maxConcurrent = 0;
  const poll = async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 25));
    concurrent -= 1;
  };

  await Promise.all([guard.run(poll), guard.run(poll), guard.run(poll)]);

  assert.equal(maxConcurrent, 1, "No two polls should overlap");
  assert.equal(guard.running, false);
});

test("serviceAddin overlap guard: skips while running, runs again after", async () => {
  const guard = createOverlapGuard();
  let runs = 0;
  const poll = async () => {
    runs += 1;
    await new Promise((r) => setTimeout(r, 10));
  };

  const p1 = guard.run(poll);
  const skipped = await guard.run(poll); // skipped
  await p1;
  assert.equal(skipped, undefined);
  assert.equal(runs, 1);

  const r2 = await guard.run(poll); // runs again
  assert.equal(r2, undefined); // poll returns void
  assert.equal(runs, 2);
});

test("serviceAddin computeBackoffMs: bounded exponential growth", () => {
  assert.equal(computeBackoffMs(0, 1000, 60000), 1000);
  assert.equal(computeBackoffMs(1, 1000, 60000), 2000);
  assert.equal(computeBackoffMs(2, 1000, 60000), 4000);
  assert.equal(computeBackoffMs(20, 1000, 60000), 60000, "Caps at max");
});