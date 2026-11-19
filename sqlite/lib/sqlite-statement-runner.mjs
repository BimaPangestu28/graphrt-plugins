/**
 * Runs a batch of statements on one SQLite file with node:sqlite.
 *
 * This runs inside the short-lived worker process (see worker-launcher.mjs),
 * so a runaway statement can be stopped by killing the process. Reads open
 * the file with `readOnly: true` and also set `PRAGMA query_only`, so SQLite
 * itself refuses writes; the SQL is not parsed to decide that.
 */
import { createResultCollector } from "./result-collector.mjs";
import { assertCompiledProgramTouchesNoOtherFiles, assertNoOtherFiles, assertSingleStatement } from "./statement-guard.mjs";

/**
 * Opens the database, runs every statement in order and closes it.
 *
 * @param request - `{databasePath, mode: "read" | "write", busyTimeoutMs, statements: [{sql, params, maxRows, maxBytes}]}` (object)
 * @param DatabaseSync - node:sqlite's DatabaseSync class (function)
 * @returns One result per statement: `{fields, rows, row_count, truncated, ...}`, plus `changes` and `last_insert_rowid` for writes (object[])
 * @throws Error - SQLite errors (with `errcode`/`errstr`) and PluginErrors from the statement guard
 */
export function runSqliteRequest(request, DatabaseSync) {
  const isRead = request.mode === "read";
  const database = new DatabaseSync(request.databasePath, { readOnly: isRead, allowExtension: false });
  try {
    database.exec(`PRAGMA busy_timeout = ${Math.trunc(Number(request.busyTimeoutMs) || 0)}`);
    if (isRead) database.exec("PRAGMA query_only = ON");
    return request.statements.map((statementRequest) => runOneStatement(database, statementRequest, isRead));
  } finally {
    database.close();
  }
}

function runOneStatement(database, statementRequest, isRead) {
  const statement = database.prepare(statementRequest.sql);
  const compiledSql = statement.sourceSQL ?? statementRequest.sql;
  assertSingleStatement(statementRequest.sql, statement.sourceSQL);
  assertNoOtherFiles(compiledSql);
  assertCompiledProgramTouchesNoOtherFiles(database, compiledSql);
  statement.setReadBigInts(true);
  const columns = typeof statement.columns === "function" ? statement.columns() : null;
  const bindValues = statementRequest.params.map(toBindValue);
  if (!isRead && columns?.length === 0) {
    const { changes, lastInsertRowid } = statement.run(...bindValues);
    return { fields: [], rows: [], row_count: 0, truncated: false, changes: Number(changes), last_insert_rowid: String(lastInsertRowid) };
  }
  const readResult = collectRows(statement, columns, bindValues, statementRequest);
  return isRead ? readResult : { ...readResult, changes: database.prepare("SELECT changes() AS n").get().n, last_insert_rowid: null };
}

function collectRows(statement, columns, bindValues, statementRequest) {
  const canReturnArrays = typeof statement.setReturnArrays === "function" && columns;
  if (canReturnArrays) statement.setReturnArrays(true);
  let collector = null;
  let fields = columns ? columns.map((column) => ({ name: column.name, type: column.type ?? null })) : [];
  for (const row of statement.iterate(...bindValues)) {
    if (!collector) {
      if (!canReturnArrays) fields = Object.keys(row).map((name) => ({ name, type: null }));
      collector = createResultCollector({ columnNames: fields.map((field) => field.name), maxRows: statementRequest.maxRows, maxBytes: statementRequest.maxBytes });
    }
    if (!collector.addRow(canReturnArrays ? row : Object.values(row))) break;
  }
  collector ??= createResultCollector({ columnNames: fields.map((field) => field.name), maxRows: statementRequest.maxRows, maxBytes: statementRequest.maxBytes });
  return { fields, ...collector.finish() };
}

// SQLite binds null, numbers, bigints, text and bytes; booleans become 1 / 0 and JSON values become JSON text.
function toBindValue(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}
