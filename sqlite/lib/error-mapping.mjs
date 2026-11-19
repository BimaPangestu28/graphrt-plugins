/**
 * Maps SQLite result codes (as serialised by the worker) to PluginError kinds.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const PRIMARY_CODE_KINDS = new Map([
  [3, "permission_denied"], [8, "permission_denied"], [23, "permission_denied"],
  [9, "cancelled"],
  [14, "not_found"],
  [19, "invalid_input"], [20, "invalid_input"], [25, "invalid_input"], [26, "invalid_input"], [18, "invalid_input"],
]);
const BUSY_CODES = new Set([5, 6]);

/**
 * Converts a worker error into a PluginError.
 *
 * @param workerError - `{message, errcode, errstr, kind}` from the worker (object)
 * @returns PluginError (PluginError)
 *
 * @example
 * mapSqliteError({ message: "no such table: items", errcode: 1 }); // kind not_found
 */
export function mapSqliteError(workerError) {
  if (workerError.kind) return new PluginError(workerError.message, { kind: workerError.kind });
  if (typeof workerError.errcode !== "number") return new PluginError(`SQLite worker error: ${workerError.message}`, { kind: "plugin_error" });
  const primaryCode = workerError.errcode & 0xff;
  const message = `SQLite error ${workerError.errcode}: ${workerError.message}`;
  if (primaryCode === 8) {
    return new PluginError(`${message}. This call opens the database read-only; use the \`execute\` operation from a workflow node for writes.`, { kind: "permission_denied" });
  }
  // A busy statement did not run, so retrying it is safe for writes too.
  if (BUSY_CODES.has(primaryCode)) return new PluginError(`${message} (another connection holds a lock; SQLITE_BUSY_TIMEOUT_MS sets how long to wait)`, { kind: "rate_limited", retryable: true });  if (primaryCode === 1) return new PluginError(message, { kind: /no such (table|column|function)/i.test(workerError.message) ? "not_found" : "invalid_input" });
  const kind = PRIMARY_CODE_KINDS.get(primaryCode) ?? "api_error";
  return new PluginError(message, { kind });
}
