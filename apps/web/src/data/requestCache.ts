/*───────────────────── Request Cache ─────────────────────*/
/* In-flight request coalescing + short TTL response cache.

   Goals:
   - Deduplicate identical concurrent reads (e.g., React effects, auto-refresh
     and manual refresh firing together) so only one network call is made.
   - Serve identical reads from a short-lived cache to avoid repeated API calls
     during a render burst or rapid navigation.
   - Allow explicit invalidation after writes so cached data never goes stale in
     a way that affects correctness.

   This cache stores public reference data only. It is NEVER used to cache
   authorization decisions, session IDs, or credentials. */

export type Fetcher<T> = () => Promise<T>;

type Entry<T> = { value: T; ts: number };

export class RequestCache<T> {
  private readonly ttlMs: number;
  private readonly entries: Map<string, Entry<T>> = new Map();
  private readonly inFlight: Map<string, Promise<T>> = new Map();

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  /* Return a cached value when fresh, otherwise coalesce concurrent callers
     onto a single fetch. The fetch result is cached for ttlMs. */
  async fetch(key: string, fetcher: Fetcher<T>): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.ts < this.ttlMs) {
      return hit.value;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const promise = (async () => {
      try {
        const value = await fetcher();
        this.entries.set(key, { value, ts: Date.now() });
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  /* Drop a single key, or the entire cache when no key is given. In-flight
     requests are allowed to settle; their results repopulate the cache. */
  invalidate(key?: string): void {
    if (key === undefined) {
      this.entries.clear();
    } else {
      this.entries.delete(key);
    }
  }

  /* Number of currently cached (settled) entries. For diagnostics/tests. */
  getSize(): number {
    return this.entries.size;
  }

  /* Number of currently in-flight requests. For diagnostics/tests. */
  pendingCount(): number {
    return this.inFlight.size;
  }

  /* Clear everything including in-flight tracking (tests/teardown). */
  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }
}