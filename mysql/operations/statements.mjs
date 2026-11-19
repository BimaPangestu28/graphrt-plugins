/**
 * Statement operations: query (read-only), execute (writes and DDL) and explain.
 */
import { assertToolWriteAllowed } from "../lib/environment-readers.mjs";
import { permissionDenied } from "../lib/errors.mjs";
import { firstStatementKeyword } from "../lib/statement-scanner.mjs";
import { TOOL_WRITES_VARIABLE } from "../lib/settings.mjs";
import { buildParamsParameter, buildStatementRequest, MAX_ROWS_PARAMETER, SQL_PARAMETER, TIMEOUT_PARAMETER } from "./parameters.mjs";

const PARAMS_PARAMETER = buildParamsParameter("?");
const EXPLAIN_PREFIXES = { traditional: "EXPLAIN ", json: "EXPLAIN FORMAT=JSON ", tree: "EXPLAIN FORMAT=TREE " };

const queryOperation = {
  name: "query",
  title: "Run a read-only query",
  description:
    "Runs one parameterised SQL statement in a READ ONLY transaction that is always rolled back, so it cannot change data. Returns rows (objects), fields, row_count and truncated",
  parameters: {
    type: "object",
    properties: { sql: SQL_PARAMETER, params: PARAMS_PARAMETER, max_rows: MAX_ROWS_PARAMETER, timeout_ms: TIMEOUT_PARAMETER },
    required: ["sql"],
  },
  run: async ({ client, args, signal, source }) => {
    assertNoProcedureCallFromAgent(args.sql, source);
    return { data: await client.readOnly({ ...buildStatementRequest(args, client.limits, source), signal }) };
  },
};

// A stored procedure can COMMIT and START TRANSACTION READ WRITE, escaping the read-only session, so agents may not CALL.
function assertNoProcedureCallFromAgent(sql, source) {
  if (source === "node" || firstStatementKeyword(sql) !== "CALL") return;
  throw permissionDenied(
    "CALL is not allowed in `query` for agents: a stored procedure can commit and start its own read-write transaction. Run it from a workflow node, and give agents an account without the EXECUTE privilege.",
  );
}

const executeOperation = {
  name: "execute",
  title: "Run a write or DDL statement",
  description:
    `Runs one parameterised INSERT/UPDATE/DELETE/DDL statement (autocommitted). Returns affected_rows, changed_rows and insert_id. Agents need ${TOOL_WRITES_VARIABLE}=1`,
  parameters: {
    type: "object",
    properties: {
      sql: SQL_PARAMETER,
      params: PARAMS_PARAMETER,
      max_rows: { ...MAX_ROWS_PARAMETER, description: "Most rows to return if the statement returns any (default 500, at most 5000)" },
      timeout_ms: { ...TIMEOUT_PARAMETER, description: "The statement is killed (KILL QUERY) when it runs this long plus 5 s (default from MYSQL_STATEMENT_TIMEOUT_MS, 30000)" },
    },
    required: ["sql"],
  },
  run: async ({ client, args, signal, source, environment }) => {
    assertToolWriteAllowed({ source, environment, optInVariable: TOOL_WRITES_VARIABLE, operationName: "execute" });
    return { data: await client.write({ ...buildStatementRequest(args, client.limits, source), signal }) };
  },
};

const explainOperation = {
  name: "explain",
  title: "Explain a query plan",
  description: "Shows MySQL's plan for one statement (EXPLAIN), in a read-only transaction. With analyze (MySQL 8.0.18+) it also runs the statement, still read-only",
  parameters: {
    type: "object",
    properties: {
      sql: SQL_PARAMETER,
      params: PARAMS_PARAMETER,
      format: { type: "string", enum: ["traditional", "json", "tree"], default: "traditional", description: "Plan as table rows, MySQL's JSON plan or a text tree (ignored with analyze, which is always a tree)" },
      analyze: { type: "boolean", default: false, description: "EXPLAIN ANALYZE: run the statement and report real timings (read-only, rolled back)" },
      timeout_ms: TIMEOUT_PARAMETER,
    },
    required: ["sql"],
  },
  run: async ({ client, args, signal, source }) => {
    const format = args.analyze ? "tree" : args.format;
    const explainPrefix = args.analyze ? "EXPLAIN ANALYZE " : EXPLAIN_PREFIXES[format];
    const statementRequest = buildStatementRequest({ ...args, sql: `${explainPrefix}${args.sql}`, max_rows: 5000 }, client.limits, source);
    const result = await client.readOnly({ ...statementRequest, signal });
    return { data: { format, analyze: args.analyze, plan: extractPlan(result, format), truncated: result.truncated } };
  },
};

function extractPlan(result, format) {
  if (format === "traditional") return result.rows;
  const planText = result.rows.map((row) => Object.values(row)[0]).join("\n");
  if (format !== "json") return planText;
  try {
    return JSON.parse(planText);
  } catch {
    return planText;
  }
}

export const statementOperations = [queryOperation, executeOperation, explainOperation];
