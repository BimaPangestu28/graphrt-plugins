/**
 * Statement operations: query (read-only connection), execute (writes and DDL) and explain.
 */
import { assertToolWriteAllowed } from "../lib/environment-readers.mjs";
import { TOOL_WRITES_VARIABLE } from "../lib/settings.mjs";
import { buildParamsParameter, buildStatementRequest, MAX_ROWS_PARAMETER, SQL_PARAMETER, TIMEOUT_PARAMETER } from "./parameters.mjs";

export const DATABASE_PARAMETER = {
  type: "string",
  minLength: 1,
  description: "Absolute path (or ~/...) of the database file, inside SQLITE_ALLOWED_DIRS. Default: SQLITE_PATH",
};
const PARAMS_PARAMETER = buildParamsParameter("? or ?1, ?2");

const queryOperation = {
  name: "query",
  title: "Run a read-only query",
  description: "Runs one parameterised SQL statement on a read-only connection, so it cannot change the file. Returns rows (objects), fields, row_count and truncated",
  parameters: {
    type: "object",
    properties: { database: DATABASE_PARAMETER, sql: SQL_PARAMETER, params: PARAMS_PARAMETER, max_rows: MAX_ROWS_PARAMETER, timeout_ms: TIMEOUT_PARAMETER },
    required: ["sql"],
  },
  run: async ({ client, args, signal, source }) => {
    const statementRequest = buildStatementRequest(args, client.limits, source);
    const { results } = await client.run({ database: args.database, mode: "read", statements: [toWorkerStatement(statementRequest)], timeoutMs: statementRequest.timeoutMs, signal });
    return { data: results[0] };
  },
};

const executeOperation = {
  name: "execute",
  title: "Run a write or DDL statement",
  description: `Runs one parameterised INSERT/UPDATE/DELETE/DDL statement (autocommitted). Returns changes, last_insert_rowid and any RETURNING rows. Agents need ${TOOL_WRITES_VARIABLE}=1`,
  parameters: {
    type: "object",
    properties: {
      database: DATABASE_PARAMETER,
      sql: SQL_PARAMETER,
      params: PARAMS_PARAMETER,
      max_rows: { ...MAX_ROWS_PARAMETER, description: "Most RETURNING rows to return (default 500, at most 5000)" },
      timeout_ms: TIMEOUT_PARAMETER,
      create_if_missing: { type: "boolean", default: false, description: "Create the database file if it does not exist (its directory must be inside SQLITE_ALLOWED_DIRS)" },
    },
    required: ["sql"],
  },
  run: async ({ client, args, signal, source, environment }) => {
    assertToolWriteAllowed({ source, environment, optInVariable: TOOL_WRITES_VARIABLE, operationName: "execute" });
    const statementRequest = buildStatementRequest(args, client.limits, source);
    const { results } = await client.run({
      database: args.database,
      mode: "write",
      createIfMissing: args.create_if_missing,
      statements: [toWorkerStatement(statementRequest)],
      timeoutMs: statementRequest.timeoutMs,
      signal,
    });
    const { rows, row_count: returnedRowCount, ...rest } = results[0];
    return { data: { ...rest, rows, returned_row_count: returnedRowCount } };
  },
};

const explainOperation = {
  name: "explain",
  title: "Explain a query plan",
  description: "Shows SQLite's plan for one statement (EXPLAIN QUERY PLAN) on a read-only connection; the statement is not run",
  parameters: {
    type: "object",
    properties: { database: DATABASE_PARAMETER, sql: SQL_PARAMETER, params: PARAMS_PARAMETER, timeout_ms: TIMEOUT_PARAMETER },
    required: ["sql"],
  },
  run: async ({ client, args, signal, source }) => {
    const statementRequest = buildStatementRequest({ ...args, sql: `EXPLAIN QUERY PLAN ${args.sql}`, max_rows: 5000 }, client.limits, source);
    const { results } = await client.run({ database: args.database, mode: "read", statements: [toWorkerStatement(statementRequest)], timeoutMs: statementRequest.timeoutMs, signal });
    return { data: { plan: formatPlanTree(results[0].rows), steps: results[0].rows, truncated: results[0].truncated } };
  },
};

/**
 * Picks the fields the worker needs from a statement request.
 *
 * @param statementRequest - From buildStatementRequest (object)
 * @returns `{sql, params, maxRows, maxBytes}` (object)
 */
export function toWorkerStatement({ sql, params, maxRows, maxBytes }) {
  return { sql, params, maxRows, maxBytes };
}

// EXPLAIN QUERY PLAN rows are `{id, parent, detail}`; children are indented under their parent.
function formatPlanTree(planRows) {
  const depthById = new Map([[0, -1]]);
  return planRows
    .map((planRow) => {
      const depth = (depthById.get(planRow.parent) ?? -1) + 1;
      depthById.set(planRow.id, depth);
      return `${"  ".repeat(depth)}${planRow.detail}`;
    })
    .join("\n");
}

export const statementOperations = [queryOperation, executeOperation, explainOperation];
