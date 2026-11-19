/**
 * Builds the per-operation "client" handed to operations: validated settings,
 * the redactor built from the connection string, and `withDatabase`, which
 * runs work on a pooled MongoClient with the EJSON codec.
 *
 * The shared runner calls `createClient` for every operation; the pool behind
 * it lives as long as the process.
 */
import { createClientPool } from "./client-pool.mjs";
import { cancelled } from "./errors.mjs";
import { createDocumentCodec } from "./documents.mjs";
import { buildUrlSecrets, createRedactor } from "./redaction.mjs";
import { resolveSettings } from "./settings.mjs";

/**
 * Creates a client factory with injectable side effects.
 *
 * @param dependencies - Overrides for tests (object, all optional)
 * @param dependencies.loadDriver - `async () => {MongoClient, EJSON}` (function)
 * @param dependencies.timers - `{setTimeout, clearTimeout}` for idle closing (object)
 * @returns `{pool, createClient({accessToken, environment}), closeAllClients(), waitForRunningOperations(timeoutMs)}` (object)
 */
export function createClientFactory(dependencies = {}) {
  const pool = createClientPool({ loadDriver: dependencies.loadDriver, timers: dependencies.timers });
  return {
    pool,
    createClient({ accessToken, environment }) {
      const redact = createRedactor(buildUrlSecrets(accessToken));
      const settings = resolveSettings(environment, accessToken);
      return {
        settings,
        redact,
        withDatabase: (databaseName, work, { signal, isWrite = false } = {}) =>
          runWithDatabase({ pool, settings, databaseName, work, signal, isWrite }),
      };
    },
    /** Closes every pooled client (plugin shutdown). */
    closeAllClients: () => pool.closeAll(),
    /** Waits for running operations, at most `timeoutMs` (plugin shutdown). */
    waitForRunningOperations: (timeoutMs) => pool.waitForIdle(timeoutMs),
  };
}

async function runWithDatabase({ pool, settings, databaseName, work, signal, isWrite }) {
  throwIfAborted(signal, false);
  const { EJSON } = await pool.loadDriver();
  const codec = createDocumentCodec(EJSON);
  const operation = pool.withClient(settings.connectionUrl, settings.idleTimeoutMs, (mongoClient) =>
    work({ mongoClient, database: databaseName === null ? null : mongoClient.db(databaseName), codec }),
  );
  return raceWithSignal(operation, signal, isWrite);
}

/**
 * Resolves with the operation, or rejects with `cancelled` as soon as the signal aborts.
 * Reads also pass the signal to the driver, which then stops the server call.
 *
 * @param operation - Running work (Promise)
 * @param signal - Host cancel or tool deadline (AbortSignal, optional)
 * @param isWrite - Writes may already have been applied when cancelled (boolean)
 * @returns The operation's result (Promise)
 */
export function raceWithSignal(operation, signal, isWrite) {
  if (!signal) return operation;
  operation.catch(() => {});
  if (signal.aborted) return Promise.reject(cancelledError(isWrite));
  let removeListener = () => {};
  const abortion = new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelledError(isWrite));
    signal.addEventListener("abort", onAbort, { once: true });
    removeListener = () => signal.removeEventListener("abort", onAbort);
  });
  return Promise.race([operation, abortion]).finally(removeListener);
}

function throwIfAborted(signal, isWrite) {
  if (signal?.aborted) throw cancelledError(isWrite);
}

function cancelledError(isWrite) {
  return cancelled(isWrite ? "the write may already have been applied; check before retrying" : "");
}
