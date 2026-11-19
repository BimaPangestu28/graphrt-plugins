/**
 * PluginError builders and Redis error classification.
 *
 * Every error that leaves an operation goes through `toPluginError`, which
 * maps ioredis and server errors to graphrt error kinds and redacts the message.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const NETWORK_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE"]);
const NETWORK_MESSAGES = /Connection is closed|connect ETIMEDOUT|Stream isn't writeable|MaxRetriesPerRequestError|Reached the max retries/i;
// Server error prefixes (the first word of a Redis error reply).
const REPLY_PREFIX_KINDS = new Map([
  ["WRONGPASS", { kind: "auth_error", retryable: false }],
  ["NOAUTH", { kind: "auth_error", retryable: false }],
  ["NOPERM", { kind: "permission_denied", retryable: false }],
  ["WRONGTYPE", { kind: "invalid_input", retryable: false }],
  ["BUSYGROUP", { kind: "conflict", retryable: false }],
  ["NOGROUP", { kind: "not_found", retryable: false }],
  ["LOADING", { kind: "database_error", retryable: true }],
  ["BUSY", { kind: "database_error", retryable: true }],
  ["TRYAGAIN", { kind: "database_error", retryable: true }],
  ["MASTERDOWN", { kind: "database_error", retryable: true }],
  ["CLUSTERDOWN", { kind: "database_error", retryable: true }],
  ["READONLY", { kind: "database_error", retryable: false }],
  ["OOM", { kind: "database_error", retryable: false }],
  ["MOVED", { kind: "database_error", retryable: false }],
  ["ASK", { kind: "database_error", retryable: false }],
  ["ERR", { kind: "invalid_input", retryable: false }],
]);
const MAX_DETAIL_CHARS = 500;

/**
 * Builds an `invalid_input` error.
 *
 * @param message - What is wrong with the arguments (string)
 * @returns PluginError kind `invalid_input`
 */
export function invalidInput(message) {
  return new PluginError(message, { kind: "invalid_input" });
}

/**
 * Builds a `permission_denied` error (tool-call limits, denied commands).
 *
 * @param message - What is not allowed and how to allow it (string)
 * @returns PluginError kind `permission_denied`
 */
export function permissionDenied(message) {
  return new PluginError(message, { kind: "permission_denied" });
}

/**
 * Builds the `cancelled` error used when the host cancels or a tool deadline passes.
 *
 * @param isWrite - Whether the command may already have run (boolean)
 * @returns PluginError kind `cancelled`
 */
export function cancelled(isWrite) {
  const detail = isWrite ? ": the write may already have been applied; check before retrying" : "";
  return new PluginError(`Redis operation cancelled${detail}`, { kind: "cancelled" });
}

/**
 * Maps any thrown value to a PluginError with a redacted message.
 *
 * @param error - Thrown value (unknown)
 * @param redact - From createRedactor (function)
 * @returns PluginError (PluginError)
 *
 * @example
 * toPluginError(new ReplyError("WRONGPASS invalid username-password pair"), redact); // kind "auth_error"
 */
export function toPluginError(error, redact) {
  if (error instanceof PluginError) {
    return new PluginError(redact(error.message), { kind: error.kind, retryable: error.retryable, retryAfterMs: error.retryAfterMs });
  }
  const detail = redact(String(error?.message ?? error)).slice(0, MAX_DETAIL_CHARS);
  const { kind, retryable, prefix } = classifyRedisError(error);
  return new PluginError(`${prefix}: ${detail}`, { kind, retryable });
}

/**
 * Picks the graphrt error kind for an ioredis or server error.
 *
 * @param error - Error (Error)
 * @returns `{kind, retryable, prefix}` (object)
 */
export function classifyRedisError(error) {
  const message = String(error?.message ?? "");
  if (NETWORK_ERROR_CODES.has(error?.code) || NETWORK_MESSAGES.test(message) || error?.name === "MaxRetriesPerRequestError") {
    return { kind: "network_error", retryable: true, prefix: "Cannot reach Redis" };
  }
  if (/Command timed out/i.test(message)) return { kind: "timeout", retryable: true, prefix: "Redis command timed out" };
  if (error?.name === "ReplyError") {
    const replyPrefix = message.split(/\s/, 1)[0];
    const mapped = REPLY_PREFIX_KINDS.get(replyPrefix) ?? { kind: "database_error", retryable: false };
    return { ...mapped, prefix: "Redis error" };
  }
  return { kind: "database_error", retryable: false, prefix: "Redis error" };
}

/**
 * Reports a missing npm dependency as `setup_required`.
 *
 * @param packageName - "ioredis" or "@ioredis/commands" (string)
 * @param importError - The failed import's error (Error)
 * @returns PluginError kind `setup_required`, or the original error when it is something else
 */
export function classifyImportError(packageName, importError) {
  const isMissing = importError?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(importError?.message ?? "");
  if (!isMissing) return importError;
  return new PluginError(`The ${packageName} package is not installed: run \`npm install\` in the redis plugin directory`, { kind: "setup_required" });
}
