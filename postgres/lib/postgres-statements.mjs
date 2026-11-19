/**
 * The work done on one pooled connection: the role check, read-only reads
 * through a cursor, and writes.
 *
 * Errors are not cleaned up here: session-guard.mjs destroys the connection
 * after any error, which also rolls back an open transaction on the server.
 * After a successful call the session is reset with `DISCARD ALL` (session
 * settings, SET ROLE, prepared statements, advisory locks, LISTEN), and the
 * connection is destroyed instead when that reset fails.
 *
 * Memory stays bounded: the first cursor batch is one row and later batches
 * are sized from the observed row size, and the socket's incoming bytes are
 * counted. Past 4 x max bytes + 1 MiB the socket is destroyed and the rows
 * collected so far are returned with `truncated_reason: "max_bytes"`.
 */
import { permissionDenied } from "./errors.mjs";
import { createResultCollector } from "./result-collector.mjs";
import { createTypeParsers, describeField } from "./type-parsers.mjs";

const MAX_CURSOR_BATCH_SIZE = 200;
const SOCKET_BUDGET_FACTOR = 4;
const SOCKET_BUDGET_SLACK_BYTES = 1024 * 1024;
const CONNECTION_CHECK_INTERVAL_MS = "2000";

/**
 * Refuses agent calls on a superuser connection (unless allowed) and warns for nodes.
 *
 * @param sessionContext - `{pgClient, request: {source, allowSuperuser}, logWarning}` (object)
 * @throws PluginError kind `permission_denied` - Tool call as superuser without POSTGRES_ALLOW_SUPERUSER=1
 */
export async function enforceRolePolicy({ pgClient, request, logWarning }) {
  const roleResult = await pgClient.query("SELECT current_setting('is_superuser') = 'on' AS is_superuser");
  if (!roleResult.rows?.[0]?.is_superuser) return;
  if (request.source === "node") {
    logWarning("this workflow node connects as a PostgreSQL superuser; read-only transactions do not limit superuser-only functions. Prefer a least-privilege role.");
    return;
  }
  if (request.allowSuperuser) return;
  throw permissionDenied(
    "The connection's role is a PostgreSQL superuser, so agent tool calls are refused: superuser-only functions are not limited by read-only transactions. Connect as a least-privilege role, or set POSTGRES_ALLOW_SUPERUSER=1.",
  );
}

/**
 * Runs one statement in a rolled-back READ ONLY transaction, then resets the session.
 *
 * @param sessionContext - From the driver (object); `mustDestroy` is set when the socket budget tripped
 * @returns `{fields, rows, row_count, truncated, ...}` (object)
 */
export async function readInsideReadOnlyTransaction(sessionContext) {
  const { pgClient, request } = sessionContext;
  await pgClient.query("BEGIN READ ONLY");
  await setSessionGuards(pgClient, request.timeoutMs, { isLocal: true });
  const readResult = await readThroughCursor(sessionContext);
  // The socket was destroyed: the server rolls back, and the connection is discarded.
  if (sessionContext.mustDestroy) return readResult;
  await pgClient.query("ROLLBACK");
  await resetSession(sessionContext);
  return readResult;
}

/**
 * Runs one write: committed in a transaction, or on its own (`inTransaction: false`, connection discarded afterwards).
 *
 * @param sessionContext - From the driver (object)
 * @returns `{command, affected_rows, fields, rows, returned_row_count, truncated}` (object)
 */
export async function writeStatement(sessionContext) {
  const { pgClient, request } = sessionContext;
  const statement = { text: request.sql, values: request.params, rowMode: "array", queryMode: "extended" };
  if (!request.inTransaction) {
    // Session-level settings and whatever the statement changed go away with the connection.
    sessionContext.mustDestroy = true;
    await setSessionGuards(pgClient, request.timeoutMs, { isLocal: false });
    return summarizeWriteResult(await pgClient.query(statement), request);
  }
  await pgClient.query("BEGIN");
  await setSessionGuards(pgClient, request.timeoutMs, { isLocal: true });
  const result = await pgClient.query(statement);
  await pgClient.query("COMMIT");
  await resetSession(sessionContext);
  return summarizeWriteResult(result, request);
}

// DISCARD ALL undoes SET ROLE, session settings, PREPARE, advisory locks and LISTEN; a failure discards the connection.
async function resetSession(sessionContext) {
  try {
    await sessionContext.pgClient.query("DISCARD ALL");
  } catch {
    sessionContext.mustDestroy = true;
  }
}

// statement_timeout, and client_connection_check_interval (PostgreSQL 14+) so a vanished client stops the backend.
async function setSessionGuards(pgClient, timeoutMs, { isLocal }) {
  await pgClient.query("SELECT set_config('statement_timeout', $1, $2)", [String(timeoutMs), isLocal]);
  await pgClient.query("SELECT set_config(name, $1, $2) FROM pg_settings WHERE name = 'client_connection_check_interval'", [CONNECTION_CHECK_INTERVAL_MS, isLocal]);
}

async function readThroughCursor(sessionContext) {
  const { pgClient, modules, request } = sessionContext;
  const cursor = pgClient.query(new modules.Cursor(request.sql, request.params, { rowMode: "array", types: createTypeParsers(modules.pg.types) }));
  const readState = { collector: null, fields: [], keptRows: 0, socketBudgetExceeded: false };
  const stopWatching = watchSocketBytes(pgClient, SOCKET_BUDGET_FACTOR * request.maxBytes + SOCKET_BUDGET_SLACK_BYTES, () => {
    readState.socketBudgetExceeded = true;
  });
  try {
    await readBatches(cursor, readState, request);
  } catch (readError) {
    if (!readState.socketBudgetExceeded) throw readError;
    sessionContext.mustDestroy = true;
    ensureCollector(readState, request).markTruncated("max_bytes");
    return { fields: readState.fields, ...readState.collector.finish() };
  } finally {
    stopWatching();
  }
  await cursor.close();
  return { fields: readState.fields, ...ensureCollector(readState, request).finish() };
}

async function readBatches(cursor, readState, request) {
  for (;;) {
    const batchSize = chooseBatchSize(readState, request);
    const { rows, result } = await readCursorBatch(cursor, batchSize);
    if (!readState.collector) {
      readState.fields = (result?.fields ?? []).map(describeField);
      ensureCollector(readState, request);
    }
    for (const row of rows) {
      if (!readState.collector.addRow(row)) return;
      readState.keptRows += 1;
    }
    if (rows.length < batchSize) return;
  }
}

// One row first; then as many rows as the remaining byte budget holds at the average row size so far.
function chooseBatchSize(readState, request) {
  if (readState.keptRows === 0) return 1;
  const averageRowBytes = Math.max(1, readState.collector.bytesCollected() / readState.keptRows);
  const rowsThatFit = Math.floor((request.maxBytes - readState.collector.bytesCollected()) / averageRowBytes);
  const rowsUntilCap = request.maxRows + 1 - readState.keptRows;
  return Math.max(1, Math.min(MAX_CURSOR_BATCH_SIZE, rowsThatFit, rowsUntilCap));
}

function ensureCollector(readState, request) {
  readState.collector ??= createResultCollector({ columnNames: readState.fields.map((field) => field.name), maxRows: request.maxRows, maxBytes: request.maxBytes });
  return readState.collector;
}

// Counts bytes arriving on the connection's socket; past the budget, destroys it (pg then fails the read).
function watchSocketBytes(pgClient, budgetBytes, onBudgetExceeded) {
  const socket = pgClient.connection?.stream;
  if (!socket?.on) return () => {};
  let receivedBytes = 0;
  const onData = (chunk) => {
    receivedBytes += chunk.length;
    if (receivedBytes <= budgetBytes) return;
    socket.off("data", onData);
    onBudgetExceeded();
    socket.destroy();
  };
  socket.on("data", onData);
  return () => socket.off("data", onData);
}

function readCursorBatch(cursor, batchSize) {
  return new Promise((resolve, reject) => {
    cursor.read(batchSize, (readError, rows, result) => (readError ? reject(readError) : resolve({ rows: rows ?? [], result })));
  });
}

function summarizeWriteResult(result, request) {
  const fields = (result.fields ?? []).map(describeField);
  const collector = createResultCollector({ columnNames: fields.map((field) => field.name), maxRows: request.maxRows, maxBytes: request.maxBytes });
  for (const row of result.rows ?? []) if (!collector.addRow(row)) break;
  const { rows, row_count: returnedRowCount, ...capFlags } = collector.finish();
  return { command: result.command ?? null, affected_rows: result.rowCount ?? null, fields, rows, returned_row_count: returnedRowCount, ...capFlags };
}
