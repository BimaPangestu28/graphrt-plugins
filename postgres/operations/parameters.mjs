/**
 * Parameter schemas and limit resolution shared by the SQL operations.
 * This file is identical in the postgres, mysql and sqlite plugins; keep the copies in step.
 */
import { invalidInput } from "../lib/errors.mjs";

export const DEFAULT_MAX_ROWS = 500;
export const MAX_ROWS_LIMIT = 5000;
const MAX_SQL_LENGTH = 100000;

export const SQL_PARAMETER = { type: "string", minLength: 1, description: "One SQL statement. Put values in `params` and refer to them with placeholders; never paste values into the SQL" };
export const MAX_ROWS_PARAMETER = { type: "integer", minimum: 1, maximum: MAX_ROWS_LIMIT, default: DEFAULT_MAX_ROWS, description: `Most rows to return (default ${DEFAULT_MAX_ROWS}, at most ${MAX_ROWS_LIMIT}); \`truncated\` is true when more existed` };
export const TIMEOUT_PARAMETER = {
  type: "integer",
  minimum: 100,
  maximum: 600000,
  description: "Statement timeout in milliseconds (default from the plugin's *_STATEMENT_TIMEOUT_MS, 30000; agents can only lower it)",
};

/**
 * Builds the `params` schema with the plugin's placeholder style in the description.
 *
 * @param placeholderHint - e.g. "$1, $2" or "?" (string)
 * @returns JSON schema for the params array (object)
 */
export function buildParamsParameter(placeholderHint) {
  return { type: "array", maxItems: 1000, default: [], description: `Values for the placeholders (${placeholderHint}), in order: strings, numbers, booleans, null or JSON objects` };
}

/**
 * Checks the SQL text and parameter values, and resolves row cap and timeout.
 *
 * @param args - Validated operation arguments `{sql, params, max_rows, timeout_ms}` (object)
 * @param limits - Plugin limits `{statementTimeoutMs, maxResultBytes}` (object)
 * @param source - "node" or "tool"; only nodes may raise the timeout above `limits.statementTimeoutMs` (string)
 * @returns `{sql, params, maxRows, maxBytes, timeoutMs, source}` (object)
 * @throws PluginError kind `invalid_input` - For over-long SQL or unsupported parameter values
 */
export function buildStatementRequest(args, limits, source) {
  if (args.sql.length > MAX_SQL_LENGTH) throw invalidInput(`\`sql\` must be at most ${MAX_SQL_LENGTH} characters`);
  if (args.sql.includes("\0")) throw invalidInput("`sql` must not contain NUL characters");
  const params = (args.params ?? []).map(checkParameterValue);
  return {
    sql: args.sql,
    params,
    maxRows: args.max_rows ?? DEFAULT_MAX_ROWS,
    maxBytes: limits.maxResultBytes,
    timeoutMs: resolveTimeoutMs(args.timeout_ms, limits.statementTimeoutMs, source),
    source,
  };
}

// The environment's timeout is the default for everyone and a ceiling for anything that is not a workflow node.
function resolveTimeoutMs(requestedTimeoutMs, configuredTimeoutMs, source) {
  const timeoutMs = requestedTimeoutMs ?? configuredTimeoutMs;
  return source === "node" ? timeoutMs : Math.min(timeoutMs, configuredTimeoutMs);
}

function checkParameterValue(value, index) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    if (typeof value === "string" && value.includes("\0")) throw invalidInput(`\`params[${index}]\` must not contain NUL characters`);
    if (typeof value === "number" && !Number.isFinite(value)) throw invalidInput(`\`params[${index}]\` must be a finite number`);
    return value;
  }
  if (typeof value === "object") return value;
  throw invalidInput(`\`params[${index}]\` must be a string, number, boolean, null or JSON value`);
}
