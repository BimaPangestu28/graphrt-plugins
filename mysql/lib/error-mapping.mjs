/**
 * Maps mysql2 and Node network errors to PluginError kinds.
 *
 * Messages are not redacted here; the definition redacts every error that
 * leaves an operation.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EPIPE",
  "PROTOCOL_CONNECTION_LOST", "PROTOCOL_SEQUENCE_TIMEOUT", "HANDSHAKE_SSL_ERROR", "HANDSHAKE_NO_SSL_SUPPORT",
]);
const ERRNO_KINDS = new Map([
  [1045, "auth_error"], [1698, "auth_error"], [1251, "auth_error"], [1862, "auth_error"],
  [1044, "permission_denied"], [1290, "permission_denied"], [1142, "permission_denied"], [1143, "permission_denied"], [1227, "permission_denied"], [1370, "permission_denied"],
  [1049, "not_found"], [1146, "not_found"], [1305, "not_found"], [1109, "not_found"],
  [3024, "timeout"], [1969, "timeout"],
  [1317, "cancelled"],
  [1040, "rate_limited"], [1203, "rate_limited"],
  [2006, "network_error"], [2013, "network_error"],
]);
const RETRYABLE_ERRNOS = new Set([1213, 1205]);
const READ_ONLY_ERRNOS = new Set([1792]);

/**
 * Converts any error thrown while talking to MySQL into a PluginError.
 *
 * @param error - Error from mysql2 or the socket (unknown)
 * @param context - `{isWrite, timeoutMs}`: writes are never marked retryable after the statement may have run (object)
 * @returns PluginError (PluginError)
 *
 * @example
 * mapMysqlError({ errno: 1064, sqlState: "42000", message: "You have an error in your SQL syntax" });
 * // PluginError kind invalid_input
 */
export function mapMysqlError(error, { isWrite = false, timeoutMs } = {}) {
  if (error instanceof PluginError) return error;
  if (typeof error?.errno === "number" && error.sqlState) return mapServerError(error, { isWrite, timeoutMs });
  if (NETWORK_ERROR_CODES.has(error?.code) || error?.fatal) {
    return new PluginError(`Cannot reach MySQL: ${error?.message ?? error}${isWrite ? ". The statement may or may not have been applied; check before retrying." : ""}`, {
      kind: "network_error",
      retryable: !isWrite,
    });
  }
  return new PluginError(`MySQL client error: ${error?.message ?? error}`, { kind: "api_error" });
}

function mapServerError(error, { isWrite, timeoutMs }) {
  const message = `MySQL error ${error.errno} (${error.sqlState}): ${String(error.sqlMessage ?? error.message).replace(/\.$/, "")}`;
  if (READ_ONLY_ERRNOS.has(error.errno)) {
    return new PluginError(`${message}. This call runs in a read-only transaction; use the \`execute\` operation from a workflow node for writes.`, { kind: "permission_denied" });
  }
  if (RETRYABLE_ERRNOS.has(error.errno)) return new PluginError(`${message}. The statement was rolled back.`, { kind: "api_error", retryable: true });
  const kind = ERRNO_KINDS.get(error.errno);
  if (kind === "timeout") return new PluginError(`${message} (limit ${timeoutMs ?? "?"} ms; pass a larger statement_timeout_ms or narrow the query)`, { kind });
  if (kind === "rate_limited") return new PluginError(message, { kind, retryable: true });
  if (kind === "network_error") return new PluginError(message, { kind, retryable: !isWrite });
  if (kind) return new PluginError(message, { kind });
  if (["42", "23", "22", "21"].some((sqlClass) => error.sqlState.startsWith(sqlClass))) return new PluginError(message, { kind: "invalid_input" });
  return new PluginError(message, { kind: "api_error" });
}
