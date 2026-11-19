/**
 * One pooled ioredis connection per URL (and command timeout), shared by every
 * operation of this process, closed after an idle period and on shutdown.
 *
 * ioredis is imported lazily, so the plugin (and `npm run sync`) loads
 * without it. The connection never reconnects or queues commands on its own:
 * a dropped connection fails the commands in flight, and the next operation
 * opens a new one. Commands of one operation share the connection, so the
 * plugin never changes connection state (SELECT, MULTI, SUBSCRIBE…).
 */
import { classifyImportError } from "./errors.mjs";

/**
 * ioredis options: bounded connect and command time, no retries, no offline queue, no auto-resubscribe.
 *
 * @param commandTimeoutMs - REDIS_COMMAND_TIMEOUT_MS (number)
 * @returns ioredis options (object)
 */
export function buildConnectionOptions(commandTimeoutMs) {
  return {
    lazyConnect: true,
    connectTimeout: 10_000,
    commandTimeout: commandTimeoutMs,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    reconnectOnError: () => false,
    enableOfflineQueue: false,
    autoResubscribe: false,
    autoResendUnfulfilledCommands: false,
    enableReadyCheck: true,
    connectionName: "graphrt-redis",
  };
}

/**
 * Default ioredis loader.
 *
 * @returns The ioredis `Redis` class (Promise<function>)
 * @throws PluginError kind `setup_required` - When ioredis is not installed
 */
export async function loadRedisClass() {
  const ioredisModule = await import("ioredis").catch((importError) => {
    throw classifyImportError("ioredis", importError);
  });
  return ioredisModule.Redis ?? ioredisModule.default;
}

/**
 * Creates the connection pool.
 *
 * @param options - Pool options (object)
 * @param options.loadRedis - `async () => RedisClass` (function, default loadRedisClass)
 * @param options.timers - `{setTimeout, clearTimeout}` for idle closing (object, default globals)
 * @returns `{withConnection(settings, work), waitForIdle(timeoutMs), closeAll(), size}` (object)
 *
 * @example
 * await pool.withConnection(settings, (connection) => connection.callBuffer("get", "k"));
 */
export function createConnectionPool({ loadRedis = loadRedisClass, timers = globalThis } = {}) {
  const entriesByKey = new Map();
  const idleWaiters = new Set();
  let runningCount = 0;

  const acquire = (settings) => {
    const poolKey = `${settings.commandTimeoutMs}|${settings.connectionUrl}`;
    let entry = entriesByKey.get(poolKey);
    if (entry && isClosed(entry)) {
      entriesByKey.delete(poolKey);
      entry = null;
    }
    if (!entry) {
      entry = { poolKey, activeCount: 0, idleTimer: null, connection: null, lastError: null };
      entry.ready = openConnection(loadRedis, settings, entry);
      entriesByKey.set(poolKey, entry);
      entry.ready.catch(() => {
        if (entriesByKey.get(poolKey) === entry) entriesByKey.delete(poolKey);
      });
    }
    if (entry.idleTimer) timers.clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    entry.activeCount += 1;
    return entry;
  };

  const release = (entry, idleTimeoutMs) => {
    entry.activeCount -= 1;
    if (entry.activeCount > 0 || entriesByKey.get(entry.poolKey) !== entry) return;
    entry.idleTimer = timers.setTimeout(() => closeEntry(entry), idleTimeoutMs);
    entry.idleTimer?.unref?.();
  };

  const closeEntry = async (entry) => {
    if (entriesByKey.get(entry.poolKey) === entry) entriesByKey.delete(entry.poolKey);
    if (entry.idleTimer) timers.clearTimeout(entry.idleTimer);
    const connection = await entry.ready.catch(() => null);
    if (!connection) return;
    await connection.quit().catch(() => connection.disconnect());
  };

  return {
    async withConnection(settings, work) {
      const entry = acquire(settings);
      runningCount += 1;
      try {
        return await work(await entry.ready);
      } finally {
        release(entry, settings.idleTimeoutMs);
        runningCount -= 1;
        if (runningCount === 0) for (const notifyIdle of idleWaiters) notifyIdle();
      }
    },
    /**
     * Waits until no operation is running, or the timeout passes (shutdown drain).
     *
     * @param timeoutMs - Longest wait (number)
     * @returns "idle" or "timeout" (Promise<string>)
     */
    waitForIdle(timeoutMs) {
      if (runningCount === 0) return Promise.resolve("idle");
      return new Promise((resolve) => {
        const finish = (outcome) => {
          idleWaiters.delete(onIdle);
          timers.clearTimeout(timer);
          resolve(outcome);
        };
        const onIdle = () => finish("idle");
        const timer = timers.setTimeout(() => finish("timeout"), timeoutMs);
        idleWaiters.add(onIdle);
      });
    },
    /** Number of cached connections (tests). */
    get size() {
      return entriesByKey.size;
    },
    /** Closes every connection (plugin shutdown). */
    async closeAll() {
      await Promise.all([...entriesByKey.values()].map((entry) => closeEntry(entry)));
    },
  };
}

async function openConnection(loadRedis, settings, entry) {
  const RedisClass = await loadRedis();
  const connection = new RedisClass(settings.connectionUrl, buildConnectionOptions(settings.commandTimeoutMs));
  entry.connection = connection;
  // ioredis reports socket errors as events; keep the last one for a precise message, never crash on it.
  connection.on("error", (connectionError) => {
    entry.lastError = connectionError;
  });
  try {
    await connection.connect();
    return connection;
  } catch (connectError) {
    connection.disconnect();
    throw preferSocketError(connectError, entry.lastError);
  }
}

// "Connection is closed." hides the cause; the socket error (ECONNREFUSED, WRONGPASS…) says more.
function preferSocketError(connectError, lastError) {
  if (lastError && /Connection is closed/i.test(String(connectError?.message))) return lastError;
  return connectError;
}

function isClosed(entry) {
  const status = entry.connection?.status;
  return status === "end" || status === "close";
}
