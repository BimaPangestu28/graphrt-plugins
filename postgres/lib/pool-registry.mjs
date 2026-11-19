/**
 * One connection pool per distinct connection, shared by every call in this
 * plugin process, closed after it has been idle for `idleCloseMs`.
 *
 * The shared runner builds a new client per call, so the registry lives in the
 * definition. Pools are keyed by a SHA-256 of the connection settings: the key
 * never shows the password. This file is identical in the postgres and mysql
 * plugins; keep the copies in step.
 */
import { createHash } from "node:crypto";

export const DEFAULT_IDLE_CLOSE_MS = 60000;

/**
 * Creates a pool registry.
 *
 * @param options - Registry options (object)
 * @param options.createPool - `(connectionSettings) => pool` (function)
 * @param options.closePool - `async (pool) => void` (function)
 * @param options.idleCloseMs - Close a pool this long after its last call ended (number, default 60000)
 * @param options.timers - `{setTimeout, clearTimeout}` for tests (object, optional)
 * @param options.logWarning - `(message) => void` for close failures (function, default console.error)
 * @returns `{withPool(connectionSettings, work), closeAll(), size()}` (object)
 *
 * @example
 * const registry = createPoolRegistry({ createPool: (settings) => new pg.Pool(settings), closePool: (pool) => pool.end() });
 * await registry.withPool(settings, (pool) => pool.query("SELECT 1"));
 */
export function createPoolRegistry({ createPool, closePool, idleCloseMs = DEFAULT_IDLE_CLOSE_MS, timers = globalThis, logWarning = console.error }) {
  const entriesByKey = new Map();

  const closeEntry = async (key, entry) => {
    if (entriesByKey.get(key) === entry) entriesByKey.delete(key);
    timers.clearTimeout(entry.idleTimer);
    await Promise.resolve(closePool(entry.pool)).catch((closeError) => logWarning(`closing an idle database pool failed: ${closeError?.message ?? closeError}`));
  };

  const scheduleIdleClose = (key, entry) => {
    timers.clearTimeout(entry.idleTimer);
    entry.idleTimer = timers.setTimeout(() => {
      if (entry.activeCalls === 0) closeEntry(key, entry);
    }, idleCloseMs);
    entry.idleTimer?.unref?.();
  };

  const acquireEntry = (connectionSettings) => {
    const key = hashSettings(connectionSettings);
    let entry = entriesByKey.get(key);
    if (!entry) {
      entry = { pool: createPool(connectionSettings), activeCalls: 0, idleTimer: null };
      entriesByKey.set(key, entry);
    }
    timers.clearTimeout(entry.idleTimer);
    entry.activeCalls += 1;
    return { key, entry };
  };

  return {
    async withPool(connectionSettings, work) {
      const { key, entry } = acquireEntry(connectionSettings);
      try {
        return await work(entry.pool);
      } finally {
        entry.activeCalls -= 1;
        if (entry.activeCalls === 0 && entriesByKey.get(key) === entry) scheduleIdleClose(key, entry);
      }
    },
    async closeAll() {
      await Promise.all([...entriesByKey.entries()].map(([key, entry]) => closeEntry(key, entry)));
    },
    size: () => entriesByKey.size,
  };
}

function hashSettings(connectionSettings) {
  return createHash("sha256").update(JSON.stringify(connectionSettings)).digest("hex");
}
