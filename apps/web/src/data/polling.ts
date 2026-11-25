/*───────────────────── Polling / Backoff Helpers ─────────────────────*/
/* Small, framework-free utilities for polling loops:
   - createInFlightGuard: prevents overlapping executions of an async task.
   - exponentialBackoffMs / applyJitter: bounded exponential backoff with
     jitter for transient-error retries.

   No credentials, session IDs, or booking data are handled here. */

export type InFlightGuard = {
  readonly running: boolean;
  run<T>(fn: () => Promise<T>): Promise<T | undefined>;
};

/* Returns a guard that skips a new run while a previous run is still in
   progress. `run` resolves to undefined when the call was skipped. */
export function createInFlightGuard(): InFlightGuard {
  let running = false;
  return {
    get running() {
      return running;
    },
    async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
      if (running) return undefined;
      running = true;
      try {
        return await fn();
      } finally {
        running = false;
      }
    },
  };
}

/* Deterministic bounded exponential backoff: base * 2^attempt, capped at max. */
export function exponentialBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const a = Math.max(0, Math.floor(attempt));
  return Math.min(baseMs * 2 ** a, maxMs);
}

/* Apply "equal jitter" (50%–100% of the value) using the supplied RNG so the
   result is deterministic in tests. */
export function applyJitter(ms: number, rand: () => number = Math.random): number {
  const r = Math.min(1, Math.max(0, rand()));
  return Math.round(ms * (0.5 + r * 0.5));
}