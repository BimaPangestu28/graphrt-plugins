/**
 * Maps pg and Node network errors to PluginError kinds.
 *
 * Messages are not redacted here; the definition redacts every error that
 * leaves an operation.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const NETWORK_ERROR_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EPIPE", "ENOENT"]);
const NETWORK_MESSAGE_PATTERN = /timeout exceeded when trying to connect|connection terminated|connection timeout|does not support SSL|self[- ]signed certificate|certificate/i;
const AUTH_SQLSTATES = new Set(["28P01", "28000"]);
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01", "55P03"]);

/**
 * Converts any error thrown while talking to PostgreSQL into a PluginError.
 *
 * @param error - Error from pg or the socket (unknown)
 * @param context - `{isWrite, timeoutMs}`: writes are never marked retryable after the statement may have run (object)
 * @returns PluginError (PluginError)
 *
 * @example
 * mapPostgresError({ code: "42601", message: "syntax error at or near \"SELEC\"" }, { isWrite: false });
 * // PluginError kind invalid_input: "PostgreSQL error 42601: syntax error at or near \"SELEC\""
 */
export function mapPostgresError(error, { isWrite = false, timeoutMs } = {}) {
  if (error instanceof PluginError) return error;
  const sqlState = typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
  if (sqlState) return mapSqlStateError(sqlState, error, { isWrite, timeoutMs });
  if (NETWORK_ERROR_CODES.has(error?.code) || NETWORK_MESSAGE_PATTERN.test(error?.message ?? "")) {
    return new PluginError(`Cannot reach PostgreSQL: ${error?.message ?? error}${isWrite ? ". The statement may or may not have been applied; check before retrying." : ""}`, {
      kind: "network_error",
      retryable: !isWrite,
    });
  }
  return new PluginError(`PostgreSQL client error: ${error?.message ?? error}`, { kind: "api_error" });
}

function mapSqlStateError(sqlState, error, { isWrite, timeoutMs }) {
  const message = formatServerMessage(sqlState, error);
  if (AUTH_SQLSTATES.has(sqlState)) return new PluginError(message, { kind: "auth_error" });
  if (sqlState === "57014") return mapCancelledStatement(message, timeoutMs);
  if (sqlState === "25006") {
    return new PluginError(`${message}. This call runs in a read-only transaction; use the \`execute\` operation from a workflow node for writes.`, { kind: "permission_denied" });
  }
  if (sqlState === "42501") return new PluginError(message, { kind: "permission_denied" });
  if (sqlState === "3D000" || sqlState === "42P01" || sqlState === "42883" || sqlState === "3F000") return new PluginError(message, { kind: "not_found" });
  if (sqlState === "53300") return new PluginError(message, { kind: "rate_limited", retryable: true });
  if (RETRYABLE_SQLSTATES.has(sqlState)) return new PluginError(`${message}. The transaction was rolled back.`, { kind: "api_error", retryable: true });
  if (sqlState.startsWith("08") || sqlState.startsWith("57P")) return new PluginError(message, { kind: "network_error", retryable: !isWrite });
  if (["22", "23", "42", "0A", "21", "2B", "44"].some((sqlClass) => sqlState.startsWith(sqlClass))) return new PluginError(message, { kind: "invalid_input" });
  return new PluginError(message, { kind: "api_error" });
}

function mapCancelledStatement(message, timeoutMs) {
  if (/statement timeout/i.test(message)) {
    return new PluginError(`${message} (limit ${timeoutMs ?? "?"} ms; pass a larger timeout_ms or narrow the query)`, { kind: "timeout" });
  }
  return new PluginError(message, { kind: "cancelled" });
}

function formatServerMessage(sqlState, error) {
  const positionText = error.position ? ` (at character ${error.position})` : "";
  const detailText = error.detail ? `; detail: ${error.detail}` : "";
  const hintText = error.hint ? `; hint: ${error.hint}` : "";
  return `PostgreSQL error ${sqlState}: ${error.message}${positionText}${detailText}${hintText}`;
}
