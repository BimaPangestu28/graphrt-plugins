/**
 * One pooled MongoClient per connection string, shared by every operation of
 * this process, closed after an idle period and on shutdown.
 *
 * The `mongodb` package is imported lazily, so the plugin (and `npm run sync`)
 * loads without it; a missing install surfaces as `setup_required`.
 *
 * Lifecycle: `withClient(url, work)` connects on first use, counts the
 * operation as active, and when the last active operation ends arms an idle
 * timer that closes the client. A failed connect is not cached.
 */
import { classifyImportError } from "./errors.mjs";

/** Driver options: bounded server selection and connect, small pool, no stdout logging. */
export const CLIENT_OPTIONS = Object.freeze({
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 10_000,
  socketTimeoutMS: 90_000,
  maxPoolSize: 5,
  minPoolSize: 0,
  maxIdleTimeMS: 60_000,
  appName: "graphrt-mongodb",
});

/**
 * Default driver loader.
 *
 * @returns `{MongoClient, EJSON}` (Promise<object>)
 * @throws PluginError kind `setup_required` - When the mongodb package is not installed
 */
export async function loadMongoDriver() {
  const driverModule = await import("mongodb").catch((importError) => {
    throw classifyImportError(importError);
  });
  return { MongoClient: driverModule.MongoClient, EJSON: driverModule.BSON.EJSON };
}

/**
 * Creates the client pool.
 *
 * @param options - Pool options (object)
 * @param options.loadDriver - `async () => {MongoClient, EJSON}` (function, default loadMongoDriver)
 * @param options.timers - `{setTimeout, clearTimeout}` for idle closing (object, default globals)
 * @returns `{withClient(url, idleTimeoutMs, work), loadDriver(), waitForIdle(timeoutMs), closeAll()}` (object)
 *
 * @example
 * const pool = createClientPool();
 * await pool.withClient(url, 300000, (client) => client.db("shop").collection("orders").findOne({}));
 */
export function createClientPool({ loadDriver = loadMongoDriver, timers = globalThis } = {}) {
  const entriesByUrl = new Map();
  const idleWaiters = new Set();
  let runningCount = 0;
  let driverPromise = null;
  const getDriver = () => {
    driverPromise ??= loadDriver().catch((loadError) => {
      driverPromise = null;
      throw loadError;
    });
    return driverPromise;
  };

  const acquire = (connectionUrl) => {
    let entry = entriesByUrl.get(connectionUrl);
    if (!entry) {
      entry = { activeCount: 0, idleTimer: null, clientPromise: connectClient(getDriver, connectionUrl) };
      entriesByUrl.set(connectionUrl, entry);
      entry.clientPromise.catch(() => {
        if (entriesByUrl.get(connectionUrl) === entry) entriesByUrl.delete(connectionUrl);
      });
    }
    if (entry.idleTimer) timers.clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    entry.activeCount += 1;
    return entry;
  };

  const release = (connectionUrl, entry, idleTimeoutMs) => {
    entry.activeCount -= 1;
    if (entry.activeCount > 0 || entriesByUrl.get(connectionUrl) !== entry) return;
    entry.idleTimer = timers.setTimeout(() => closeEntry(connectionUrl, entry), idleTimeoutMs);
    entry.idleTimer?.unref?.();
  };

  const closeEntry = async (connectionUrl, entry) => {
    if (entriesByUrl.get(connectionUrl) === entry) entriesByUrl.delete(connectionUrl);
    if (entry.idleTimer) timers.clearTimeout(entry.idleTimer);
    const client = await entry.clientPromise.catch(() => null);
    await client?.close().catch((closeError) => console.error(`[mongodb] closing a client failed: ${closeError?.name ?? "error"}`));
  };

  return {
    loadDriver: getDriver,
    async withClient(connectionUrl, idleTimeoutMs, work) {
      const entry = acquire(connectionUrl);
      runningCount += 1;
      try {
        return await work(await entry.clientPromise);
      } finally {
        release(connectionUrl, entry, idleTimeoutMs);
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
    /** Number of cached clients (tests). */
    get size() {
      return entriesByUrl.size;
    },
    /** Closes every client (plugin shutdown). */
    async closeAll() {
      await Promise.all([...entriesByUrl.entries()].map(([connectionUrl, entry]) => closeEntry(connectionUrl, entry)));
    },
  };
}

async function connectClient(getDriver, connectionUrl) {
  const { MongoClient } = await getDriver();
  const client = new MongoClient(connectionUrl, { ...CLIENT_OPTIONS });
  try {
    await client.connect();
    return client;
  } catch (connectError) {
    await client.close().catch(() => {});
    throw connectError;
  }
}
