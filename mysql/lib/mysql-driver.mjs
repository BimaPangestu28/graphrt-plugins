/**
 * Runs statements on MySQL / MariaDB through pooled mysql2 connections.
 *
 * - Reads (`runReadOnly`) run inside `START TRANSACTION READ ONLY` with a
 *   session `max_execution_time`, and are rolled back, so the server itself
 *   refuses writes; nothing parses the SQL. Rows are streamed, and at the row
 *   or byte cap the connection is destroyed instead of reading the rest.
 * - Writes (`runWrite`) run as one autocommitted statement.
 * - Statements with `params` use server-side prepared statements (`execute`);
 *   without params the text protocol is used, with multiple statements off.
 * - Cancel (host abort or tool deadline) and a client-side guard timer send
 *   `KILL QUERY <thread id>` on a separate connection and destroy the pooled one.
 * - The pool resets each connection when it is released (COM_RESET_CONNECTION),
 *   so session variables, temporary tables and locks never reach the next caller.
 *
 * mysql2 is imported lazily, so a missing `npm install` is reported as
 * `setup_required` and unit tests can inject a fake.
 */
import { cancelled, classifyImportError } from "./errors.mjs";
import { mapMysqlError } from "./error-mapping.mjs";
import { createPoolRegistry } from "./pool-registry.mjs";
import { createResultCollector } from "./result-collector.mjs";
import { buildColumnAdapters } from "./column-types.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";

// Past the statement timeout, the client gives the server this long before killing the query itself.
export const CLIENT_GUARD_GRACE_MS = 5000;
// After KILL QUERY was sent, the call fails this long later even if the connection never answers.
export const INTERRUPT_GRACE_MS = 3000;
const KILL_CONNECT_TIMEOUT_MS = 5000;
const POOL_IDLE_CONNECTION_MS = 30000;
const UNKNOWN_SYSTEM_VARIABLE_ERRNO = 1193;
// Bytes on the wire per call: past 4 x max result bytes + 1 MiB the connection is dropped.
const SOCKET_BUDGET_FACTOR = 4;
const SOCKET_BUDGET_SLACK_BYTES = 1024 * 1024;

/**
 * Creates the driver with injectable side effects.
 *
 * @param dependencies - Overrides for tests (object, all optional)
 * @param dependencies.loadMysql - `async () => mysql2 module` (function)
 * @param dependencies.poolRegistryOptions - Extra createPoolRegistry options, e.g. `{idleCloseMs, timers}` (object)
 * @param dependencies.logWarning - `(message) => void` for background connection errors (function)
 * @returns `{runReadOnly(connection, request), runWrite(connection, request), closeAll()}` (object)
 */
export function createMysqlDriver(dependencies = {}) {
  const loadMysql = dependencies.loadMysql ?? loadInstalledMysql;
  const logWarning = dependencies.logWarning ?? ((message) => console.error(`[mysql] ${message}`));
  let mysqlModule = null;
  const getMysql = async () => {
    mysqlModule ??= await loadMysql();
    return mysqlModule;
  };
  const registry = createPoolRegistry({
    // Pools are only created after getMysql() resolved.
    createPool: (poolSettings) => createPool(mysqlModule, poolSettings, logWarning),
    closePool: (pool) => new Promise((resolve) => pool.end(() => resolve())),
    logWarning,
    ...dependencies.poolRegistryOptions,
  });

  const withSession = async (connection, request, work) => {
    const mysql = await getMysql();
    const poolSettings = buildPoolSettings(connection, request.limits);
    return registry.withPool(poolSettings, async (pool) => {
      const mysqlConnection = await getPooledConnection(pool, request);
      return runGuardedSession({ mysqlConnection, mysql, poolSettings, request, mustDestroy: false }, work);
    });
  };

  return {
    runReadOnly: (connection, request) => withSession(connection, { ...request, isWrite: false }, readInsideReadOnlyTransaction),
    runWrite: (connection, request) => withSession(connection, { ...request, isWrite: true }, writeStatement),
    closeAll: () => registry.closeAll(),
  };
}

async function loadInstalledMysql() {
  const mysqlImport = await import("mysql2").catch((importError) => {
    throw classifyImportError("mysql2", "mysql", importError);
  });
  return mysqlImport.default ?? mysqlImport;
}

// Plain data only: the pool registry hashes it to find the pool.
function buildPoolSettings(connection, limits) {
  const { host, port, user, password, database, sslMode } = connection;
  return { host, port, user, password, database, sslMode, connectTimeoutMs: limits.connectTimeoutMs, poolMax: limits.poolMax };
}

function buildConnectionOptions(poolSettings) {
  const { sslMode, connectTimeoutMs, poolMax: _poolMax, ...connectionFields } = poolSettings;
  const sslOption = sslMode === "require" ? { rejectUnauthorized: false } : sslMode === "verify-full" ? { rejectUnauthorized: true } : undefined;
  return {
    ...connectionFields,
    user: connectionFields.user ?? undefined,
    password: connectionFields.password ?? undefined,
    database: connectionFields.database ?? undefined,
    ...(sslOption ? { ssl: sslOption } : {}),
    connectTimeout: connectTimeoutMs,
    charset: "utf8mb4",
    multipleStatements: false,
    // LOAD DATA LOCAL INFILE would let the server read files from this machine.
    flags: ["-LOCAL_FILES"],
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: true,
    timezone: "Z",
  };
}

function createPool(mysql, poolSettings, logWarning) {
  const pool = mysql.createPool({
    ...buildConnectionOptions(poolSettings),
    connectionLimit: poolSettings.poolMax,
    maxIdle: poolSettings.poolMax,
    idleTimeout: POOL_IDLE_CONNECTION_MS,
    resetOnRelease: true,
    enableKeepAlive: true,
  });
  // A fatal error on an idle connection is emitted on it; without a listener Node would crash the plugin.
  pool.on("connection", (pooledConnection) => {
    pooledConnection.on("error", (connectionError) => logWarning(`idle connection error: ${connectionError?.code ?? ""} ${connectionError?.message ?? connectionError}`));
  });
  return pool;
}

function getPooledConnection(pool, request) {
  if (request.signal?.aborted) return Promise.reject(cancelled("before connecting"));
  return new Promise((resolve, reject) => {
    let isSettled = false;
    const onAbort = () => {
      isSettled = true;
      reject(cancelled("while connecting"));
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    pool.getConnection((connectError, pooledConnection) => {
      request.signal?.removeEventListener("abort", onAbort);
      if (isSettled) {
        // A connection that arrives after the abort goes straight back to the pool.
        pooledConnection?.release();
        return;
      }
      if (connectError) reject(mapMysqlError(connectError, { isWrite: false }));
      else resolve(pooledConnection);
    });
  });
}

// Watches the caller's signal and a client-side guard timer. Either one kills the query; if the work has not
// ended INTERRUPT_GRACE_MS later (dead network), the call fails anyway and the connection is destroyed.
async function runGuardedSession(sessionContext, work) {
  const { mysqlConnection, request } = sessionContext;
  const interruption = createInterruption(() => killRunningQuery(sessionContext));
  const onAbort = () => interruption.interrupt("cancelled");
  if (request.signal?.aborted) interruption.interrupt("cancelled");
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const guardTimer = setTimeout(() => interruption.interrupt("timeout"), request.timeoutMs + CLIENT_GUARD_GRACE_MS);
  const workPromise = work(sessionContext);
  workPromise.catch(() => {});
  let isConnectionReusable = false;
  try {
    const result = await Promise.race([workPromise, interruption.promise]);
    isConnectionReusable = !interruption.reason();
    // A killed read can still "succeed" (SLEEP returns 1), so its result is not trusted; a finished write is reported.
    if (interruption.reason() && !request.isWrite) throw new Error("interrupted");
    return result;
  } catch (workError) {
    const reason = interruption.reason();
    // A server-side SQL error leaves the connection usable (the work already rolled back); anything else may not.
    isConnectionReusable = !reason && isServerError(workError);
    throw reason ? interruptionError(reason, request) : mapMysqlError(workError, { isWrite: request.isWrite, timeoutMs: request.timeoutMs });
  } finally {
    clearTimeout(guardTimer);
    interruption.dispose();
    request.signal?.removeEventListener("abort", onAbort);
    if (isConnectionReusable && !sessionContext.mustDestroy) mysqlConnection.release();
    else mysqlConnection.destroy();
  }
}

function isServerError(error) {
  return typeof error?.errno === "number" && Boolean(error.sqlState) && !error.fatal && !error.rollbackFailed;
}

function createInterruption(sendKill) {
  let interruptionReason = null;
  let rejectPromise = () => {};
  let graceTimer = null;
  const promise = new Promise((_resolve, reject) => {
    rejectPromise = reject;
  });
  promise.catch(() => {});
  return {
    promise,
    reason: () => interruptionReason,
    interrupt(reason) {
      if (interruptionReason) return;
      interruptionReason = reason;
      Promise.resolve().then(sendKill).catch(() => {});
      graceTimer = setTimeout(() => rejectPromise(new Error("interrupted")), INTERRUPT_GRACE_MS);
    },
    dispose: () => clearTimeout(graceTimer),
  };
}

function interruptionError(reason, request) {
  const writeNote = request.isWrite ? "the statement may or may not have been applied; check before retrying" : "";
  if (reason === "timeout") {
    return new PluginError(`MySQL did not finish within ${request.timeoutMs + CLIENT_GUARD_GRACE_MS} ms; the query was killed${writeNote ? `; ${writeNote}` : ""}`, { kind: "timeout" });
  }
  return cancelled(writeNote);
}

// KILL QUERY on a fresh connection: the pooled one is busy, and the pool may be full.
function killRunningQuery({ mysqlConnection, mysql, poolSettings }) {
  const threadId = mysqlConnection.threadId;
  if (!Number.isInteger(threadId)) return Promise.resolve();
  return new Promise((resolve) => {
    const killConnection = mysql.createConnection({ ...buildConnectionOptions(poolSettings), connectTimeout: KILL_CONNECT_TIMEOUT_MS });
    killConnection.on("error", () => {});
    killConnection.query("KILL QUERY ?", [threadId], () => {
      killConnection.destroy();
      resolve();
    });
  });
}

// DDL commits implicitly and would escape a READ ONLY transaction, so the session default is read-only as well:
// the implicit transaction a DDL statement starts is then refused too (error 1792).
async function readInsideReadOnlyTransaction(sessionContext) {
  const { mysqlConnection, request } = sessionContext;
  await runSimpleStatement(mysqlConnection, "SET SESSION TRANSACTION READ ONLY");
  await setSessionTimeouts(mysqlConnection, request.timeoutMs);
  await runSimpleStatement(mysqlConnection, "START TRANSACTION READ ONLY");
  try {
    const readResult = await streamStatement(sessionContext);
    // A connection stopped mid-stream is destroyed, which rolls the transaction back on the server.
    if (!sessionContext.mustDestroy) await runSimpleStatement(mysqlConnection, "ROLLBACK");
    const { header: _header, ...rowsResult } = readResult;
    return rowsResult;
  } catch (readError) {
    await rollbackAfterError(mysqlConnection, readError);
    throw readError;
  }
}

// MySQL uses max_execution_time (ms, SELECT only); MariaDB has max_statement_time (seconds) instead.
async function setSessionTimeouts(mysqlConnection, timeoutMs) {
  try {
    await runSimpleStatement(mysqlConnection, "SET SESSION max_execution_time = ?, time_zone = '+00:00'", [timeoutMs]);
  } catch (setError) {
    if (setError?.errno !== UNKNOWN_SYSTEM_VARIABLE_ERRNO) throw setError;
    await runSimpleStatement(mysqlConnection, "SET SESSION max_statement_time = ?, time_zone = '+00:00'", [timeoutMs / 1000]);
  }
}

// The pool resets sessions on release; the explicit READ WRITE is a second guard against a read-only leftover.
async function writeStatement(sessionContext) {
  await runSimpleStatement(sessionContext.mysqlConnection, "SET SESSION TRANSACTION READ WRITE");
  await runSimpleStatement(sessionContext.mysqlConnection, "SET SESSION time_zone = '+00:00'");
  const { header, rows, row_count: returnedRowCount, ...rest } = await streamStatement(sessionContext);
  return {
    affected_rows: header?.affectedRows ?? null,
    changed_rows: header?.changedRows ?? null,
    insert_id: header?.insertId === undefined || header?.insertId === null ? null : String(header.insertId),
    warning_count: header?.warningStatus ?? null,
    rows,
    returned_row_count: returnedRowCount,
    ...rest,
  };
}

async function rollbackAfterError(mysqlConnection, statementError) {
  try {
    await runSimpleStatement(mysqlConnection, "ROLLBACK");
  } catch {
    if (statementError && typeof statementError === "object") statementError.rollbackFailed = true;
  }
}

function runSimpleStatement(mysqlConnection, sql, values = []) {
  return new Promise((resolve, reject) => {
    mysqlConnection.query(sql, values, (statementError, result) => (statementError ? reject(statementError) : resolve(result)));
  });
}

// Streams the first result set of one statement under the caps; at a cap the connection is destroyed.
function streamStatement(sessionContext) {
  const { mysqlConnection, request } = sessionContext;
  const statementOptions = { sql: request.sql, rowsAsArray: true };
  const command = request.params.length > 0 ? mysqlConnection.execute(statementOptions, request.params) : mysqlConnection.query(statementOptions);
  return new Promise((resolve, reject) => {
    const streamState = { collector: null, fields: [], adapters: [], header: null, resultSetCount: 0, isSettled: false };
    const finishResult = () => ({ fields: streamState.fields, header: streamState.header, ...ensureCollector(streamState, request).finish() });
    const stopWatching = watchSocketBytes(mysqlConnection, SOCKET_BUDGET_FACTOR * request.maxBytes + SOCKET_BUDGET_SLACK_BYTES, () => {
      // Far more bytes than the result may hold (e.g. huge BLOBs): stop reading and drop the connection.
      sessionContext.mustDestroy = true;
      ensureCollector(streamState, request).markTruncated("max_bytes");
      mysqlConnection.destroy();
      settle(resolve, finishResult());
    });
    const settle = (settleFunction, value) => {
      if (streamState.isSettled) return;
      streamState.isSettled = true;
      stopWatching();
      settleFunction(value);
    };
    command.on("fields", (columnDefinitions) => {
      if (!streamState.isSettled) startResultSet(streamState, request, columnDefinitions);
    });
    command.on("result", (resultItem) => {
      if (!Array.isArray(resultItem)) {
        streamState.header ??= resultItem;
        return;
      }
      if (streamState.resultSetCount > 1 || streamState.isSettled) return;
      const isKept = ensureCollector(streamState, request).addRow(streamState.adapters.length ? resultItem.map((value, index) => streamState.adapters[index](value)) : resultItem);
      if (isKept) return;
      sessionContext.mustDestroy = true;
      mysqlConnection.pause?.();
      settle(resolve, finishResult());
    });
    command.on("error", (statementError) => settle(reject, statementError));
    command.on("end", () => settle(resolve, finishResult()));
  });
}

// Counts bytes arriving on the connection's socket and calls `onBudgetExceeded` once past the budget.
function watchSocketBytes(mysqlConnection, budgetBytes, onBudgetExceeded) {
  const socket = mysqlConnection.stream;
  if (!socket?.on) return () => {};
  let receivedBytes = 0;
  const onData = (chunk) => {
    receivedBytes += chunk.length;
    if (receivedBytes <= budgetBytes) return;
    socket.off("data", onData);
    onBudgetExceeded();
  };
  socket.on("data", onData);
  return () => socket.off("data", onData);
}

function startResultSet(streamState, request, columnDefinitions) {
  streamState.resultSetCount += 1;
  if (streamState.resultSetCount > 1 || !columnDefinitions) return;
  const { fields, adapters } = buildColumnAdapters(columnDefinitions);
  streamState.fields = fields;
  streamState.adapters = adapters;
  streamState.collector = createResultCollector({ columnNames: fields.map((field) => field.name), maxRows: request.maxRows, maxBytes: request.maxBytes });
}

function ensureCollector(streamState, request) {
  streamState.collector ??= createResultCollector({ columnNames: [], maxRows: request.maxRows, maxBytes: request.maxBytes });
  return streamState.collector;
}
