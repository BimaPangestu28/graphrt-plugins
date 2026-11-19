/**
 * In-memory TTL cache for holiday lists. A plugin process serves many calls, and a year's list changes only when the
 * government issues or amends an SKB, so one fetch per year per TTL is plenty. Concurrent calls share one load;
 * failed loads are not cached. The cache lives as long as the plugin process; nothing is written to disk.
 */

const DEFAULT_MAX_ENTRIES = 64;

/**
 * Creates a TTL cache.
 *
 * @param options - Cache options (object, optional)
 * @param options.now - Clock in milliseconds, for tests (function, default Date.now)
 * @param options.maxEntries - Entries kept; the oldest is evicted first (number, default 64)
 * @returns `{getOrLoad(key, ttlMs, load), size(), clear()}` (object)
 *
 * @example
 * const cache = createTtlCache();
 * const holidays = await cache.getOrLoad("2026", 6 * 3600 * 1000, () => fetchYear(2026));
 */
export function createTtlCache({ now = Date.now, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const entries = new Map();
  const getOrLoad = (key, ttlMs, load) => {
    if (!(ttlMs > 0)) return load();
    const cached = entries.get(key);
    if (cached && cached.expiresAt > now()) return cached.promise;
    const promise = Promise.resolve().then(load);
    entries.delete(key);
    entries.set(key, { promise, expiresAt: now() + ttlMs });
    promise.catch(() => {
      if (entries.get(key)?.promise === promise) entries.delete(key);
    });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return promise;
  };
  return { getOrLoad, size: () => entries.size, clear: () => entries.clear() };
}
