/**
 * Hand-written clickhouse operations. Query parameters are `param_<name>` URL entries whose names come from the
 * caller, which the declarative layer cannot express, so these three operations build their request here and use
 * the plugin's REST client (same base URL, auth, redaction and retries).
 *
 * - `query`: POST, SQL in the body, `readonly=1` as the last URL setting. ClickHouse checks every URL setting of a
 *   request against the session's settings before applying them (HTTPHandler.cpp: one checkSettingsConstraints
 *   call for the batch), so the limits sent next to it apply, while the query's own SETTINGS clause and SET are
 *   refused under readonly=1, and so are writes, DDL and most table functions (url, s3, file, remote).
 * - `insert_rows`: rows as JSONEachRow into a backtick-quoted table; the SQL is generated, never caller-written.
 * - `execute`: any statement (DDL, mutations, DROP); node only.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { truncateForTool, DEFAULT_TOOL_OUTPUT } from "./shared/rest-response.mjs";
import { buildParameterQuery, quoteIdentifier } from "./clickhouse-sql.mjs";
import { enforceResultCaps } from "./result-caps.mjs";

/** Opt-in env for agent-tool inserts. */
export const WRITE_OPT_IN_ENV = "CLICKHOUSE_TOOL_ALLOW_WRITES";
const MAX_QUERY_SECONDS = 120;
/** Largest max_result_bytes an agent tool may ask for (nodes: up to 100 MB). */
export const TOOL_MAX_RESULT_BYTES = 10 * 1024 * 1024;
const REQUEST_MARGIN_MS = 10000;
const READONLY_SETTING_REFUSAL = /Code: 164\. DB::Exception: .*Cannot modify '[^']+' setting in readonly mode/;
const UNKNOWN_OUTCOME_NOTE = " (outcome unknown: the write may have been applied; check before retrying)";
const TEXT_SQL = { "content-type": "text/plain; charset=utf-8" };

const sqlParam = { type: "string", minLength: 1, description: "One SQL statement; use {name:Type} placeholders with `parameters` for values" };
const parametersParam = { type: "object", description: 'Values for {name:Type} placeholders, e.g. {"user_id": 7, "tags": ["a"]}' };
const databaseParam = { type: "string", description: "Default database for unqualified table names" };
const secondsParam = (defaultSeconds) => ({ type: "integer", minimum: 1, maximum: MAX_QUERY_SECONDS, default: defaultSeconds, description: `Server-side time limit in seconds (max_execution_time, at most ${MAX_QUERY_SECONDS})` });

function schema(properties, required) {
  return { type: "object", properties, required };
}

/**
 * Sends one SQL request and returns the parsed body plus the X-ClickHouse-Summary header.
 *
 * @param context - Operation context `{client, signal}` (object)
 * @param request - `{query, body, idempotent, seconds, headers?}` (object)
 * @returns `{body, summary}` (Promise<object>)
 * @throws PluginError - API errors; kind `api_error` when ClickHouse reports an exception inside a 200 body
 */
async function sendSql(context, { query, body, idempotent, seconds, headers = TEXT_SQL }) {
  const response = await context.client.requestWithHeaders({
    method: "POST",
    path: "/",
    query,
    body,
    headers,
    idempotent,
    timeoutMs: seconds * 1000 + REQUEST_MARGIN_MS,
    signal: context.signal,
    redactResponse: true,
  });
  assertNoStreamedException(response);
  return { body: response.body, summary: parseSummary(response.headers.get("x-clickhouse-summary")) };
}

// A query that fails after the 200 status was sent ends with the exception text in the body.
function assertNoStreamedException({ body, headers }) {
  const exceptionCode = headers.get("x-clickhouse-exception-code");
  const text = typeof body?.text === "string" ? body.text : "";
  if (!exceptionCode && !/Code: \d+\. DB::Exception/.test(text)) return;
  const message = text.match(/Code: \d+\. DB::Exception[^\n]*/)?.[0] ?? `exception code ${exceptionCode}`;
  throw new PluginError(`API error: ${message}`, { kind: "api_error" });
}

function parseSummary(summaryHeader) {
  if (!summaryHeader) return null;
  try {
    return JSON.parse(summaryHeader);
  } catch {
    return null;
  }
}

function databaseQuery(database) {
  return database ? { database } : {};
}

function shapeForSource(data, source) {
  return source === "tool" ? truncateForTool(data, DEFAULT_TOOL_OUTPUT) : data;
}

const queryOperation = {
  name: "query",
  title: "Run read-only query",
  description:
    "Run one read-only SQL statement (SELECT, SHOW, DESCRIBE, EXPLAIN) with readonly=1, a time limit and result caps; returns JSON {meta, data, rows, statistics}",
  parameters: schema(
    {
      sql: sqlParam,
      parameters: parametersParam,
      database: databaseParam,
      max_execution_time: secondsParam(30),
      max_result_rows: { type: "integer", minimum: 1, maximum: 1000000, default: 10000, description: "Row cap for the result" },
      max_result_bytes: { type: "integer", minimum: 1024, maximum: 104857600, default: TOOL_MAX_RESULT_BYTES, description: `Uncompressed byte cap for the result (agent tools: at most ${TOOL_MAX_RESULT_BYTES})` },
      result_overflow_mode: { type: "string", enum: ["throw", "break"], default: "throw", description: "throw: fail when a cap is hit; break: return the rows read so far" },
    },
    ["sql"],
  ),
  run: async (context) => {
    const { args } = context;
    assertToolResultBytes(args, context.source);
    const request = { body: args.sql, idempotent: false, seconds: args.max_execution_time };
    const baseQuery = { default_format: "JSON", ...databaseQuery(args.database), ...buildParameterQuery(args.parameters) };
    try {
      const { body } = await sendReadOnlyQuery(context, baseQuery, request);
      return { data: shapeForSource(body, context.source) };
    } catch (queryError) {
      throw describeReadOnlyFailure(queryError);
    }
  },
};

function assertToolResultBytes(args, source) {
  if (source !== "tool" || !(args.max_result_bytes > TOOL_MAX_RESULT_BYTES)) return;
  throw new PluginError(`max_result_bytes may be at most ${TOOL_MAX_RESULT_BYTES} for agent tools; add a LIMIT or select fewer columns`, { kind: "invalid_input" });
}

function buildLimitSettings(args) {
  return {
    max_execution_time: args.max_execution_time,
    max_result_rows: args.max_result_rows,
    max_result_bytes: args.max_result_bytes,
    result_overflow_mode: args.result_overflow_mode,
    wait_end_of_query: 1,
    // Last, so it is never followed by anything; ClickHouse checks the whole batch before applying it.
    readonly: 1,
  };
}

/**
 * Sends a query with readonly=1 and the limits. A user whose own profile is readonly=1 may not change any setting
 * ("Cannot modify 'max_execution_time' setting in readonly mode"). The profile's readonly value is then read
 * without settings: at 1 the query is sent once more without settings (still read-only, under the profile's
 * limits; the row and byte caps are then applied client-side to the parsed result); at 2 (which allows SET and table functions) it is refused; at 0 the refusal came from the query's own
 * SETTINGS clause, so the original error stands.
 *
 * @param context - Operation context (object)
 * @param baseQuery - Format, database and parameter entries (object)
 * @param request - `{body, idempotent, seconds}` (object)
 * @returns `{body, summary}` (Promise<object>)
 * @throws PluginError kind `permission_denied` - The user's profile is readonly=2
 */
async function sendReadOnlyQuery(context, baseQuery, request) {
  try {
    return await sendSql(context, { ...request, query: { ...baseQuery, ...buildLimitSettings(context.args) } });
  } catch (firstError) {
    if (!READONLY_SETTING_REFUSAL.test(firstError?.message ?? "")) throw firstError;
    const profileReadonly = await readProfileReadonly(context);
    if (profileReadonly === "1") return sendWithoutSettings(context, baseQuery, request);
    if (profileReadonly === "2") {
      throw new PluginError(
        "This ClickHouse user's profile is readonly=2, which still allows SET and table functions, so `query` cannot enforce readonly=1; use a user with readonly=0 or readonly=1",
        { kind: "permission_denied" },
      );
    }
    throw firstError;
  }
}

async function sendWithoutSettings(context, baseQuery, request) {
  const response = await sendSql(context, { ...request, query: baseQuery });
  const { max_result_rows: maxRows, max_result_bytes: maxBytes, result_overflow_mode: overflowMode } = context.args;
  return { ...response, body: enforceResultCaps(response.body, { maxRows, maxBytes, overflowMode }) };
}

async function readProfileReadonly(context) {
  const probe = { body: "SELECT toString(getSetting('readonly')) AS readonly", idempotent: false, seconds: 10, query: { default_format: "JSON" } };
  const { body } = await sendSql(context, probe);
  return body?.data?.[0]?.readonly;
}

const insertRowsOperation = {
  name: "insert_rows",
  title: "Insert rows",
  description: `Insert rows (objects of column: value) into a table as JSONEachRow; returns written_rows (as an agent tool only when ${WRITE_OPT_IN_ENV}=1)`,
  parameters: schema(
    {
      table: { type: "string", minLength: 1, description: "Table name" },
      database: { type: "string", description: "Database of the table (default: the user's default database)" },
      rows: { type: "array", items: { type: "object" }, maxItems: 10000, description: "Rows, e.g. [{\"id\": 1, \"event\": \"signup\"}]" },
      max_execution_time: secondsParam(60),
    },
    ["table", "rows"],
  ),
  run: async (context) => {
    const { args, source, environment } = context;
    if (source === "tool" && environment?.[WRITE_OPT_IN_ENV] !== "1") {
      throw new PluginError(`\`insert_rows\` is disabled for agent tools; set ${WRITE_OPT_IN_ENV}=1 to allow it, or use a workflow node`, { kind: "permission_denied" });
    }
    if (args.rows.length === 0) throw new PluginError("`rows` must have at least one row", { kind: "invalid_input" });
    const target = args.database ? `${quoteIdentifier(args.database)}.${quoteIdentifier(args.table)}` : quoteIdentifier(args.table);
    const query = { query: `INSERT INTO ${target} FORMAT JSONEachRow`, max_execution_time: args.max_execution_time, allow_ddl: 0 };
    const body = args.rows.map((row) => JSON.stringify(row)).join("\n");
    try {
      const { summary } = await sendSql(context, { query, body, idempotent: false, seconds: args.max_execution_time, headers: { "content-type": "application/x-ndjson" } });
      return { data: { written_rows: summary ? Number(summary.written_rows) : null, summary } };
    } catch (insertError) {
      throw addCheckHint(insertError, `SELECT count() FROM ${target} (or look for the new rows) before inserting again`);
    }
  },
};

// Read-only queries are sent as non-idempotent so the client never repeats them: a ClickHouse exception or a
// timeout (often HTTP 500) would fail the same way again and cost up to max_execution_time each time. Nothing can
// have been written under readonly=1, so the client's "outcome unknown" note is dropped and the caller may retry.
function describeReadOnlyFailure(queryError) {
  if (!(queryError instanceof PluginError) || !queryError.message.includes(UNKNOWN_OUTCOME_NOTE)) return queryError;
  return new PluginError(queryError.message.replace(UNKNOWN_OUTCOME_NOTE, ""), { kind: queryError.kind, retryable: true });
}

function addCheckHint(insertError, hint) {
  if (!(insertError instanceof PluginError) || !insertError.message.includes("outcome unknown")) return insertError;
  return new PluginError(`${insertError.message}. To check: ${hint}`, { kind: insertError.kind, retryable: false });
}

const executeOperation = {
  name: "execute",
  title: "Execute statement",
  description: "Run any SQL statement (INSERT ... SELECT, CREATE, ALTER, mutations, DROP, TRUNCATE) without readonly; returns JSON output, if any, and the write summary",
  nodeOnly: true,
  parameters: schema({ sql: sqlParam, parameters: parametersParam, database: databaseParam, max_execution_time: secondsParam(60) }, ["sql"]),
  run: async (context) => {
    const { args } = context;
    const query = { default_format: "JSON", ...databaseQuery(args.database), ...buildParameterQuery(args.parameters), max_execution_time: args.max_execution_time, wait_end_of_query: 1 };
    const { body, summary } = await sendSql(context, { query, body: args.sql, idempotent: false, seconds: args.max_execution_time });
    return { data: { result: body, summary } };
  },
};

/** The hand-written operations, appended to the declarative ones. */
export const sqlOperations = [queryOperation, insertRowsOperation, executeOperation];
