/*───────────────────── Polling / Backoff Helper Tests ─────────────────────*/

import test from "node:test";
import assert from "node:assert/strict";
import {
  createInFlightGuard,
  exponentialBackoffMs,
  applyJitter,
} from "../src/data/polling.ts";

test("InFlightGuard: skips a concurrent run while one is in progress", async () => {
  const guard = createInFlightGuard();
  let runs = 0;
  const task = async () => {
    runs += 1;
    await new Promise((r) => setTimeout(r, 20));
    return "done";
  };

  const first = guard.run(task);
  const second = guard.run(task); // should be skipped
  assert.equal(guard.running, true);

  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1, "done");
  assert.equal(r2, undefined, "Overlapping run should resolve to undefined");
  assert.equal(runs, 1, "Task body should execute only once");
  assert.equal(guard.running, false, "Guard should reset after completion");
});

test("InFlightGuard: allows a new run after the previous completes", async () => {
  const guard = createInFlightGuard();
  let runs = 0;
  const task = async () => {
    runs += 1;
    return runs;
  };

  await guard.run(task);
  await guard.run(task);
  assert.equal(runs, 2);
});

test("InFlightGuard: resets running flag even if the task throws", async () => {
  const guard = createInFlightGuard();
  await assert.rejects(() => guard.run(async () => {
    throw new Error("BOOM");
  }), /BOOM/);
  assert.equal(guard.running, false);
});

test("exponentialBackoffMs: grows exponentially and caps at max", () => {
  assert.equal(exponentialBackoffMs(0, 1000, 30000), 1000);
  assert.equal(exponentialBackoffMs(1, 1000, 30000), 2000);
  assert.equal(exponentialBackoffMs(2, 1000, 30000), 4000);
  assert.equal(exponentialBackoffMs(10, 1000, 30000), 30000, "Should cap at max");
  assert.equal(exponentialBackoffMs(-5, 1000, 30000), 1000, "Negative attempts clamp to base");
});

test("applyJitter: deterministic with injected RNG and bounded to 50-100%", () => {
  assert.equal(applyJitter(1000, () => 0), 500, "Min jitter is 50%");
  assert.equal(applyJitter(1000, () => 1), 1000, "Max jitter is 100%");
  assert.equal(applyJitter(1000, () => 0.5), 750, "Midpoint");
  const v = applyJitter(1000, () => 2); // out-of-range clamps to 1
  assert.equal(v, 1000);
});