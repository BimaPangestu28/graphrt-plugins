/**
 * Statement operations on the SQL API v2: execute (submitted asynchronously, then polled up to SNOWFLAKE_WAIT_MS),
 * status, result pages (partitions) and cancel.
 *
 * Agent tools: only statements the guard classifies as read-only (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN without write
 * keywords or SYSTEM$ calls) run, unless SNOWFLAKE_TOOL_ALLOW_WRITES=1; they always use SNOWFLAKE_TOOL_ROLE when set
 * and may not choose a role or warehouse. Every statement is sent with MULTI_STATEMENT_COUNT=1 and a timeout.
 * Cancelling a call (abort) cancels the running statement.
 */
import { randomUUID } from "node:crypto";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { pathSegment } from "../lib/shared/path.mjs";
import { resolvePollInterval } from "../lib/shared/polling.mjs";
import { sleepUnlessCancelled } from "../lib/shared/sleep.mjs";
import { checkObjectName, TOOL_ROLE_VARIABLE, TOOL_WRITES_VARIABLE } from "../lib/settings.mjs";
import { classifyStatement } from "../lib/statement-guard.mjs";
import { decodeResultsCursor, shapePartitionPage, shapeResultSet, STATEMENT_HANDLE_PATTERN } from "../lib/statement-results.mjs";
import { buildBindings } from "../lib/snowflake-values.mjs";
import { assertToolOwnsHandle, rememberToolHandle } from "../lib/tool-handles.mjs";

const STATEMENTS_PATH = "/api/v2/statements";
const DEFAULT_POLL_INTERVAL_MS = 1000;
const HANDLE_PROPERTY = { type: "string", minLength: 1, description: "statement_handle from execute" };
const PAGE_PROPERTIES = { max_rows: { type: "integer", minimum: 1, maximum: 10000, default: 1000, description: "Maximum rows in this page (also capped by SNOWFLAKE_MAX_RESULT_BYTES)" } };

function checkHandle(handle) {
  if (!STATEMENT_HANDLE_PATTERN.test(handle)) throw new PluginError("`statement_handle` must be a statement handle (a UUID)", { kind: "invalid_input" });
  return `${STATEMENTS_PATH}/${pathSegment(handle)}`;
}

function assertToolMayRun({ source, args, client }, classification) {
  if (source !== "tool") return;
  if (args.role !== undefined || args.warehouse !== undefined) throw new PluginError(`Agent tools cannot choose a role or warehouse (${TOOL_ROLE_VARIABLE} sets the tool role)`, { kind: "permission_denied" });
  if (!client.settings.toolRole && !client.settings.allowToolWrites) {
    throw new PluginError(`Agent tools need ${TOOL_ROLE_VARIABLE} (a least-privilege role of a separate user, see README), or ${TOOL_WRITES_VARIABLE}=1; use a workflow node otherwise`, { kind: "permission_denied" });
  }
  if (classification.isReadOnly || client.settings.allowToolWrites) return;
  throw new PluginError(`Agent tools may only run read-only statements; this one is refused because ${classification.reason}. Set ${TOOL_WRITES_VARIABLE}=1 to allow writes, or use a workflow node`, { kind: "permission_denied" });
}

function buildSubmitBody({ args, source, client }) {
  const { defaults, toolRole, statementTimeoutSeconds } = client.settings;
  const role = source === "tool" ? (toolRole ?? defaults.role) : (args.role ?? defaults.role);
  const timeoutSeconds = source === "tool" ? Math.min(args.timeout_seconds ?? statementTimeoutSeconds, statementTimeoutSeconds) : (args.timeout_seconds ?? statementTimeoutSeconds);
  const pickName = (name, label, fallback) => (name === undefined ? fallback : checkObjectName(name, `\`${label}\``));
  return {
    statement: args.statement,
    timeout: timeoutSeconds,
    database: pickName(args.database, "database", defaults.database),
    schema: pickName(args.schema, "schema", defaults.schema),
    warehouse: pickName(args.warehouse, "warehouse", defaults.warehouse),
    role: args.role === undefined ? role : checkObjectName(role, "`role`"),
    bindings: buildBindings(args.bindings),
    parameters: { MULTI_STATEMENT_COUNT: "1", QUERY_TAG: args.query_tag ?? "graphrt" },
  };
}

async function submitStatement(context, classification) {
  const requestId = randomUUID();
  const request = { method: "POST", path: STATEMENTS_PATH, query: { requestId, async: "true" }, json: buildSubmitBody(context), signal: context.signal, idempotent: classification.isReadOnly };
  try {
    return await context.client.request(request);
  } catch (submitError) {
    if (!(submitError instanceof PluginError) || !submitError.message.includes("outcome unknown")) throw submitError;
    const hint = `. To check: look for request id ${requestId} or query tag ${request.json.parameters.QUERY_TAG} in the query history`;
    throw new PluginError(`${submitError.message}${hint}`, { kind: submitError.kind, retryable: false });
  }
}

// Best effort: the call was abandoned, so the statement should not keep running (and billing) on its own.
function cancelInBackground(client, handle) {
  client.request({ method: "POST", path: `${checkHandle(handle)}/cancel`, json: {}, idempotent: true, signal: AbortSignal.timeout(10000) }).catch((cancelError) => console.error(`[snowflake] cancelling ${handle} failed: ${cancelError.message}`));
}

async function waitForResult(context, handle, waitMs) {
  const { client, signal } = context;
  const deadline = Date.now() + waitMs;
  const intervalMs = resolvePollInterval(client.environment, DEFAULT_POLL_INTERVAL_MS);
  try {
    for (;;) {
      const response = await client.requestWithHeaders({ path: checkHandle(handle), signal });
      if (response.status === 200) return shapeResultSet(response.body, readLimits(context));
      if (Date.now() + intervalMs > deadline) return describeRunning(handle);
      await sleepUnlessCancelled(intervalMs, signal, "Statement wait cancelled");
    }
  } catch (waitError) {
    if (signal?.aborted) cancelInBackground(client, handle);
    throw waitError;
  }
}

function describeRunning(handle) {
  return { data: { status: "running", statement_handle: handle, note: "Still running: call get_statement_status with this statement_handle" }, next_cursor: null };
}

function readLimits({ args, client }) {
  return { maxRows: args.max_rows ?? 1000, maxResultBytes: client.settings.maxResultBytes };
}

async function executeStatement(context) {
  const classification = classifyStatement(context.args.statement);
  assertToolMayRun(context, classification);
  const submitted = await submitStatement(context, classification);
  if (!submitted.statementHandle) throw new PluginError("Snowflake did not return a statement handle", { kind: "api_error" });
  if (context.source === "tool") rememberToolHandle(submitted.statementHandle);
  if (submitted.resultSetMetaData) return shapeResultSet(submitted, readLimits(context));
  if (context.args.wait === false) return describeRunning(submitted.statementHandle);
  return waitForResult(context, submitted.statementHandle, context.client.settings.waitMs);
}

async function readResultsPage(context) {
  const position = decodeResultsCursor(context.args.cursor);
  assertToolOwnsHandle(context.source, position.handle);
  const response = await context.client.requestWithHeaders({ path: checkHandle(position.handle), query: { partition: position.partition }, signal: context.signal });
  if (response.status !== 200) return describeRunning(position.handle);
  // Partition 0 comes with the metadata; later partitions are bare `data`, so the metadata is fetched alongside.
  const metadata = response.body.resultSetMetaData ?? (await context.client.request({ path: checkHandle(position.handle), signal: context.signal })).resultSetMetaData;
  const page = shapePartitionPage(metadata, response.body.data, position, readLimits(context));
  return { data: { status: "succeeded", statement_handle: position.handle, rows: page.rows, truncated: page.truncated }, next_cursor: page.next_cursor };
}

export const statementOperations = [
  {
    name: "execute",
    title: "Execute statement",
    description: `Run one SQL statement with ? bindings and return typed rows (paged with next_cursor). As an agent tool only read-only statements (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN) run unless ${TOOL_WRITES_VARIABLE}=1`,
    parameters: {
      type: "object",
      properties: {
        statement: { type: "string", minLength: 1, description: "One SQL statement, e.g. SELECT id, total FROM orders WHERE status = ? LIMIT 100" },
        bindings: { type: "array", maxItems: 1000, description: "Values for the ? placeholders in order; typed values as {\"type\": \"DATE\", \"value\": \"2026-11-19\"}" },
        database: { type: "string", description: "Database (default SNOWFLAKE_DATABASE)" },
        schema: { type: "string", description: "Schema (default SNOWFLAKE_SCHEMA)" },
        warehouse: { type: "string", description: "Warehouse (default SNOWFLAKE_WAREHOUSE; nodes only)" },
        role: { type: "string", description: "Role (default SNOWFLAKE_ROLE; nodes only, tools use SNOWFLAKE_TOOL_ROLE)" },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 3600, description: "Statement timeout (default SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS, which also caps tool calls)" },
        wait: { type: "boolean", default: true, description: "Wait up to SNOWFLAKE_WAIT_MS for the result; false returns the statement_handle at once" },
        query_tag: { type: "string", description: "QUERY_TAG for the query history (default graphrt)" },
        ...PAGE_PROPERTIES,
      },
      required: ["statement"],
    },
    run: executeStatement,
  },
  {
    name: "get_statement_status",
    title: "Statement status",
    description: "Check a statement started by execute; waits up to SNOWFLAKE_WAIT_MS and returns its first page of rows when it has finished",
    parameters: { type: "object", properties: { statement_handle: HANDLE_PROPERTY, wait: { type: "boolean", default: true, description: "Wait for it to finish (up to SNOWFLAKE_WAIT_MS)" }, ...PAGE_PROPERTIES }, required: ["statement_handle"] },
    run: async (context) => {
      checkHandle(context.args.statement_handle);
      assertToolOwnsHandle(context.source, context.args.statement_handle);
      return waitForResult(context, context.args.statement_handle, context.args.wait === false ? 0 : context.client.settings.waitMs);
    },
  },
  {
    name: "get_statement_results",
    title: "Statement results page",
    description: "Next page of a finished statement's rows (across result partitions), from a next_cursor",
    parameters: { type: "object", properties: { cursor: { type: "string", minLength: 1, description: "next_cursor from execute, get_statement_status or get_statement_results" }, ...PAGE_PROPERTIES }, required: ["cursor"] },
    run: readResultsPage,
  },
  {
    name: "cancel_statement",
    title: "Cancel statement",
    description: "Cancel a running statement",
    parameters: { type: "object", properties: { statement_handle: HANDLE_PROPERTY }, required: ["statement_handle"] },
    run: async ({ client, args, signal, source }) => {
      const path = `${checkHandle(args.statement_handle)}/cancel`;
      assertToolOwnsHandle(source, args.statement_handle);
      const response = await client.request({ method: "POST", path, json: {}, signal, idempotent: true });
      return { data: { cancelled: true, statement_handle: args.statement_handle, message: response.message ?? null } };
    },
  },
];
