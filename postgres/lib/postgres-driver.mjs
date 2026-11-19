/**
 * Runs statements on PostgreSQL through pooled pg connections.
 *
 * - Reads (`runReadOnly`) run inside `BEGIN READ ONLY` and are always rolled
 *   back, so the database itself refuses writes; nothing parses the SQL (see
 *   postgres-statements.mjs).
 * - Writes (`runWrite`) run in a committed transaction, or on their own with
 *   `inTransaction: false`.
 * - A connection goes back to the pool only after a call succeeded and its
 *   session was reset (`DISCARD ALL`); after any error, an interruption or an
 *   `inTransaction: false` write it is destroyed.
 * - Cancel and timeouts are handled by session-guard.mjs (pg_cancel_backend,
 *   then pg_terminate_backend).
 *
 * pg and pg-cursor are imported lazily, so a missing `npm install` is reported
 * as `setup_required` and unit tests can inject fakes.
 */
import { cancelled, classifyImportError } from "./errors.mjs";
import { mapPostgresError } from "./error-mapping.mjs";
import { createPoolRegistry } from "./pool-registry.mjs";
import { enforceRolePolicy, readInsideReadOnlyTransaction, writeStatement } from "./postgres-statements.mjs";
import { runGuardedSession } from "./session-guard.mjs";
import { createTypeParsers } from "./type-parsers.mjs";

const POOL_IDLE_CLIENT_MS = 30000;
const CONTROL_CONNECT_TIMEOUT_MS = 5000;
const APPLICATION_NAME = "graphrt-postgres";

/**
 * Creates the driver with injectable side effects.
 *
 * @param dependencies - Overrides for tests (object, all optional)
 * @param dependencies.loadDriverModules - `async () => ({pg, Cursor})` (function)
 * @param dependencies.poolRegistryOptions - Extra createPoolRegistry options, e.g. `{idleCloseMs, timers}` (object)
 * @param dependencies.logWarning - `(message) => void` for pool errors and superuser warnings (function)
 * @returns `{runReadOnly(connection, request), runWrite(connection, request), closeAll()}` (object)
 */
export function createPostgresDriver(dependencies = {}) {
  const loadDriverModules = dependencies.loadDriverModules ?? loadInstalledDriverModules;
  const logWarning = dependencies.logWarning ?? ((message) => console.error(`[postgres] ${message}`));
  let driverModules = null;
  const getDriverModules = async () => {
    driverModules ??= await loadDriverModules();
    return driverModules;
  };
  const registry = createPoolRegistry({
    // Pools are only created after getDriverModules() resolved.
    createPool: (poolSettings) => createPool(driverModules, poolSettings, logWarning),
    closePool: (pool) => pool.end(),
    logWarning,
    ...dependencies.poolRegistryOptions,
  });

  const withSession = async (connection, request, work) => {
    const modules = await getDriverModules();
    const poolSettings = buildPoolSettings(connection, request.limits);
    return registry.withPool(poolSettings, async (pool) => {
      const pgClient = await connectClient(pool, request.signal);
      const createControlClient = () => new modules.pg.Client({ ...buildClientConfig(poolSettings, modules), connectionTimeoutMillis: CONTROL_CONNECT_TIMEOUT_MS });
      const sessionContext = { pgClient, modules, request, logWarning, createControlClient, mustDestroy: false };
      return runGuardedSession(sessionContext, async (context) => {
        await enforceRolePolicy(context);
        return work(context);
      });
    });
  };

  return {
    runReadOnly: (connection, request) => withSession(connection, { ...request, isWrite: false }, readInsideReadOnlyTransaction),
    runWrite: (connection, request) => withSession(connection, { ...request, isWrite: true }, writeStatement),
    closeAll: () => registry.closeAll(),
    poolCount: () => registry.size(),
  };
}

async function loadInstalledDriverModules() {
  const pgModule = await import("pg").catch((importError) => {
    throw classifyImportError("pg", "postgres", importError);
  });
  const cursorModule = await import("pg-cursor").catch((importError) => {
    throw classifyImportError("pg-cursor", "postgres", importError);
  });
  return { pg: pgModule.default ?? pgModule, Cursor: cursorModule.default ?? cursorModule };
}

// Plain data only: the pool registry hashes it to find the pool.
function buildPoolSettings(connection, limits) {
  const connectionFields = connection.connectionString
    ? { connectionString: connection.connectionString }
    : { host: connection.host, port: connection.port, user: connection.user ?? undefined, password: connection.password ?? undefined, database: connection.database ?? undefined, sslMode: connection.sslMode };
  return { ...connectionFields, connectTimeoutMs: limits.connectTimeoutMs, statementTimeoutMs: limits.statementTimeoutMs, poolMax: limits.poolMax };
}

function buildClientConfig(poolSettings, modules) {
  const { connectTimeoutMs, statementTimeoutMs, sslMode, poolMax: _poolMax, ...connectionFields } = poolSettings;
  const sslOption = sslMode === "require" ? { rejectUnauthorized: false } : sslMode === "verify-full" ? { rejectUnauthorized: true } : undefined;
  return {
    ...connectionFields,
    ...(sslOption ? { ssl: sslOption } : {}),
    connectionTimeoutMillis: connectTimeoutMs,
    statement_timeout: statementTimeoutMs,
    application_name: APPLICATION_NAME,
    types: createTypeParsers(modules.pg.types),
  };
}

function createPool(modules, poolSettings, logWarning) {
  const pool = new modules.pg.Pool({ ...buildClientConfig(poolSettings, modules), max: poolSettings.poolMax, idleTimeoutMillis: POOL_IDLE_CLIENT_MS, allowExitOnIdle: true });
  // An idle client that loses its socket emits on the pool; without a listener Node would crash the plugin.
  pool.on("error", (poolError) => logWarning(`idle connection error: ${String(poolError?.message ?? poolError).replace(/(:\/\/[^:/@\s]*:)[^@\s]*@/g, "$1[redacted]@")}`));
  return pool;
}

async function connectClient(pool, signal) {
  if (signal?.aborted) throw cancelled("before connecting");
  const connectPromise = pool.connect();
  const mappedConnect = connectPromise.catch((connectError) => Promise.reject(mapPostgresError(connectError)));
  if (!signal) return mappedConnect;
  let removeAbortListener = () => {};
  const abortPromise = new Promise((_resolve, reject) => {
    const onAbort = () => reject(cancelled("while connecting"));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([mappedConnect, abortPromise]);
  } catch (raceError) {
    // A connection that arrives after the abort goes straight back to the pool.
    connectPromise.then((lateClient) => lateClient.release(), () => {});
    throw raceError;
  } finally {
    removeAbortListener();
  }
}
