/**
 * Statement operations: query (read-only), execute (writes and DDL) and explain.
 */
import { assertToolWriteAllowed } from "../lib/environment-readers.mjs";
import { TOOL_WRITES_VARIABLE } from "../lib/settings.mjs";
import { buildParamsParameter, buildStatementRequest, MAX_ROWS_PARAMETER, SQL_PARAMETER, TIMEOUT_PARAMETER } from "./parameters.mjs";

const PARAMS_PARAMETER = buildParamsParameter("$1, $2, ...");

const queryOperation = {
  name: "query",
  title: "Run a read-only query",
  description:
    "Runs one parameterised SQL statement in a READ ONLY transaction that is always rolled back, so it cannot change data. Returns rows (objects), fields, row_count and truncated",
  parameters: {
    type: "object",
    properties: { sql: SQL_PARAMETER, params: PARAMS_PARAMETER, max_rows: MAX_ROWS_PARAMETER, statement_timeout_ms: TIMEOUT_PARAMETER },
    required: ["sql"],
  },
  run: async ({ client, args, signal, source }) => ({ data: await client.readOnly({ ...buildStatementRequest(args, client.limits, source), signal }) }),
};

const executeOperation = {
  name: "execute",
  title: "Run a write or DDL statement",
  description:
    `Runs one parameterised INSERT/UPDATE/DELETE/DDL statement and commits it. Returns command, affected_rows and any RETURNING rows. Agents need ${TOOL_WRITES_VARIABLE}=1`,
  parameters: {
    type: "object",
    properties: {
      sql: SQL_PARAMETER,
      params: PARAMS_PARAMETER,
      max_rows: { ...MAX_ROWS_PARAMETER, description: "Most RETURNING rows to return (default 500, at most 5000)" },
      statement_timeout_ms: TIMEOUT_PARAMETER,
      in_transaction: {
        type: "boolean",
        default: true,
        description: "Run inside BEGIN/COMMIT (default). Set false for statements that cannot run in a transaction, such as VACUUM or CREATE INDEX CONCURRENTLY",
      },
    },
    required: ["sql"],
  },
  run: async ({ client, args, signal, source, environment }) => {
    assertToolWriteAllowed({ source, environment, optInVariable: TOOL_WRITES_VARIABLE, operationName: "execute" });
    return { data: await client.write({ ...buildStatementRequest(args, client.limits, source), inTransaction: args.in_transaction, signal }) };
  },
};

const explainOperation = {
  name: "explain",
  title: "Explain a query plan",
  description: "Shows PostgreSQL's plan for one statement (EXPLAIN), in a read-only transaction. With analyze it also runs the statement, still read-only",
  parameters: {
    type: "object",
    properties: {
      sql: SQL_PARAMETER,
      params: PARAMS_PARAMETER,
      analyze: { type: "boolean", default: false, description: "EXPLAIN ANALYZE: run the statement and report real timings (read-only, rolled back)" },
      format: { type: "string", enum: ["text", "json"], default: "text", description: "Plan as text lines or as PostgreSQL's JSON plan" },
      statement_timeout_ms: TIMEOUT_PARAMETER,
    },
    required: ["sql"],
  },
  run: async ({ client, args, signal, source }) => {
    const explainPrefix = `EXPLAIN (FORMAT ${args.format === "json" ? "JSON" : "TEXT"}, ANALYZE ${args.analyze ? "TRUE" : "FALSE"}) `;
    const statementRequest = buildStatementRequest({ ...args, sql: `${explainPrefix}${args.sql}`, max_rows: 5000 }, client.limits, source);
    const result = await client.readOnly({ ...statementRequest, signal });
    return { data: { format: args.format, analyze: args.analyze, plan: extractPlan(result, args.format), truncated: result.truncated } };
  },
};

function extractPlan(result, format) {
  const planValues = result.rows.map((row) => Object.values(row)[0]);
  if (format === "json") return planValues[0] ?? null;
  return planValues.join("\n");
}

export const statementOperations = [queryOperation, executeOperation, explainOperation];
