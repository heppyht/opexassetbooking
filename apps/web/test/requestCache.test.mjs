/*───────────────────── Request Cache Tests ─────────────────────*/
/* Unit tests for in-flight request coalescing and short-TTL caching.
   Verifies deduplication, TTL expiry, and invalidation. */

import test from "node:test";
import assert from "node:assert/strict";
import { RequestCache } from "../src/data/requestCache.ts";

test("RequestCache: concurrent identical reads share one fetch (dedup)", async () => {
  const cache = new RequestCache(10_000);
  let fetchCount = 0;
  const fetcher = async () => {
    fetchCount += 1;
    await new Promise((r) => setTimeout(r, 20));
    return { v: fetchCount };
  };

  const [a, b] = await Promise.all([
    cache.fetch("k", fetcher),
    cache.fetch("k", fetcher),
  ]);

  assert.equal(fetchCount, 1, "Fetcher should run exactly once for concurrent callers");
  assert.deepEqual(a, b);
  assert.equal(cache.pendingCount(), 0, "In-flight should be cleared after settle");
});

test("RequestCache: different keys do not coalesce", async () => {
  const cache = new RequestCache(10_000);
  let fetchCount = 0;
  const fetcher = async () => {
    fetchCount += 1;
    return fetchCount;
  };

  const [a, b] = await Promise.all([
    cache.fetch("a", fetcher),
    cache.fetch("b", fetcher),
  ]);

  assert.equal(fetchCount, 2);
  assert.notEqual(a, b);
});

test("RequestCache: cached value served within TTL without refetching", async () => {
  const cache = new RequestCache(10_000);
  let fetchCount = 0;
  const fetcher = async () => ++fetchCount;

  const first = await cache.fetch("k", fetcher);
  const second = await cache.fetch("k", fetcher);

  assert.equal(first, 1);
  assert.equal(second, 1, "Second read within TTL should be served from cache");
  assert.equal(fetchCount, 1);
  assert.equal(cache.getSize(), 1);
});

test("RequestCache: entry expires after TTL and refetches", async () => {
  const cache = new RequestCache(20); // 20ms TTL
  let fetchCount = 0;
  const fetcher = async () => ++fetchCount;

  const first = await cache.fetch("k", fetcher);
  await new Promise((r) => setTimeout(r, 35));
  const second = await cache.fetch("k", fetcher);

  assert.equal(first, 1);
  assert.equal(second, 2, "Expired entry should trigger a refetch");
  assert.equal(fetchCount, 2);
});

test("RequestCache: invalidate() clears all entries", async () => {
  const cache = new RequestCache(10_000);
  let fetchCount = 0;
  const fetcher = async () => ++fetchCount;

  await cache.fetch("a", fetcher);
  await cache.fetch("b", fetcher);
  assert.equal(cache.getSize(), 2);

  cache.invalidate();
  assert.equal(cache.getSize(), 0);

  await cache.fetch("a", fetcher);
  assert.equal(fetchCount, 3, "Invalidated key should refetch");
});

test("RequestCache: invalidate(key) clears only the given key", async () => {
  const cache = new RequestCache(10_000);
  let fetchCount = 0;
  const fetcher = async () => ++fetchCount;

  await cache.fetch("a", fetcher);
  await cache.fetch("b", fetcher);
  cache.invalidate("a");
  assert.equal(cache.getSize(), 1);

  await cache.fetch("a", fetcher); // refetch
  await cache.fetch("b", fetcher); // still cached
  assert.equal(fetchCount, 3, "Only 'a' should have been refetched");
});

test("RequestCache: rejected fetch is not cached and clears in-flight", async () => {
  const cache = new RequestCache(10_000);
  let attempts = 0;
  const failing = async () => {
    attempts += 1;
    throw new Error("NETWORK");
  };

  await assert.rejects(() => cache.fetch("k", failing), /NETWORK/);
  assert.equal(cache.pendingCount(), 0, "In-flight cleared after rejection");

  // A subsequent call should retry (not serve a cached rejection).
  await assert.rejects(() => cache.fetch("k", failing), /NETWORK/);
  assert.equal(attempts, 2);
  assert.equal(cache.getSize(), 0);
});