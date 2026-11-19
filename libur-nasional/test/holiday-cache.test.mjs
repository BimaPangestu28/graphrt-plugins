import { test } from "node:test";
import assert from "node:assert/strict";
import { createTtlCache } from "../lib/holiday-cache.mjs";

function createClock(startMs = 0) {
  const clock = { nowMs: startMs, now: () => clock.nowMs };
  return clock;
}

test("a cached value is reused until its TTL passes", async () => {
  const clock = createClock();
  const cache = createTtlCache({ now: clock.now });
  let loads = 0;
  const load = async () => (loads += 1);
  assert.equal(await cache.getOrLoad("2026", 1000, load), 1);
  clock.nowMs = 999;
  assert.equal(await cache.getOrLoad("2026", 1000, load), 1);
  clock.nowMs = 1000;
  assert.equal(await cache.getOrLoad("2026", 1000, load), 2);
});

test("concurrent calls share one load", async () => {
  const cache = createTtlCache({ now: createClock().now });
  let loads = 0;
  const load = () => new Promise((resolve) => setTimeout(() => resolve((loads += 1)), 5));
  const results = await Promise.all([cache.getOrLoad("k", 1000, load), cache.getOrLoad("k", 1000, load)]);
  assert.deepEqual(results, [1, 1]);
});

test("a failed load is not cached", async () => {
  const cache = createTtlCache({ now: createClock().now });
  await assert.rejects(cache.getOrLoad("k", 1000, async () => { throw new Error("down"); }), /down/);
  assert.equal(await cache.getOrLoad("k", 1000, async () => "ok"), "ok");
});

test("TTL 0 disables caching", async () => {
  const cache = createTtlCache({ now: createClock().now });
  let loads = 0;
  await cache.getOrLoad("k", 0, async () => (loads += 1));
  await cache.getOrLoad("k", 0, async () => (loads += 1));
  assert.equal(loads, 2);
});

test("the oldest entry is evicted past maxEntries", async () => {
  const cache = createTtlCache({ now: createClock().now, maxEntries: 2 });
  let loads = 0;
  const load = async () => (loads += 1);
  await cache.getOrLoad("a", 1000, load);
  await cache.getOrLoad("b", 1000, load);
  await cache.getOrLoad("c", 1000, load);
  assert.equal(cache.size(), 2);
  await cache.getOrLoad("a", 1000, load);
  assert.equal(loads, 4);
});
