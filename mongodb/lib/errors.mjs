/**
 * PluginError builders and MongoDB driver error classification.
 *
 * Every error that leaves an operation goes through `toPluginError`, which
 * maps driver errors to graphrt error kinds and redacts the message.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const NETWORK_ERROR_NAMES = new Set([
  "MongoServerSelectionError",
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoTopologyClosedError",
  "MongoNotConnectedError",
  "MongoServerClosedError",
  "MongoClientClosedError",
]);
const NETWORK_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE"]);
const INPUT_ERROR_NAMES = new Set(["MongoParseError", "MongoInvalidArgumentError", "MongoAPIError", "BSONError"]);
// AuthenticationFailed, and the errors a missing or unsupported mechanism raises.
const AUTH_ERROR_CODES = new Set([18]);
const UNAUTHORIZED_CODES = new Set([13]);
const MAX_TIME_EXPIRED_CODES = new Set([50, 262]);
const DUPLICATE_KEY_CODES = new Set([11000, 11001]);
// BadValue, FailedToParse, TypeMismatch, ConflictingUpdateOperators, DollarPrefixedFieldName, EmptyFieldName,
// DottedFieldName, ImmutableField, InvalidOptions, InvalidNamespace, InvalidPipelineOperator,
// path collisions in projections, unrecognized pipeline stage.
const INPUT_ERROR_CODES = new Set([2, 9, 14, 40, 52, 56, 57, 66, 72, 73, 168, 31249, 31254, 40324]);
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
 * Builds a `permission_denied` error (tool-call limits).
 *
 * @param message - What is not allowed and how to allow it (string)
 * @returns PluginError kind `permission_denied`
 */
export function permissionDenied(message) {
  return new PluginError(message, { kind: "permission_denied" });
}

/**
 * Builds a `setup_required` error (missing npm dependency or configuration).
 *
 * @param message - What to set up (string)
 * @returns PluginError kind `setup_required`
 */
export function setupRequired(message) {
  return new PluginError(message, { kind: "setup_required" });
}

/**
 * Builds the `cancelled` error used when the host cancels or a tool deadline passes.
 *
 * @param detail - What may already have happened, e.g. for writes (string, optional)
 * @returns PluginError kind `cancelled`
 */
export function cancelled(detail = "") {
  return new PluginError(`MongoDB operation cancelled${detail ? `: ${detail}` : ""}`, { kind: "cancelled" });
}

/**
 * Maps any thrown value to a PluginError with a redacted message.
 *
 * @param error - Thrown value (unknown)
 * @param redact - From createRedactor (function)
 * @returns PluginError (PluginError)
 *
 * @example
 * toPluginError(serverSelectionError, redact); // kind "network_error", retryable
 */
export function toPluginError(error, redact) {
  const detail = redact(String(error?.message ?? error)).slice(0, MAX_DETAIL_CHARS);
  if (error instanceof PluginError) {
    return new PluginError(redact(error.message), { kind: error.kind, retryable: error.retryable, retryAfterMs: error.retryAfterMs });
  }
  const { kind, retryable, prefix } = classifyDriverError(error);
  const codeName = typeof error?.codeName === "string" ? ` (${error.codeName})` : "";
  return new PluginError(`${prefix}${codeName}: ${detail}`, { kind, retryable });
}

/**
 * Picks the graphrt error kind for a driver error.
 *
 * @param error - Driver error (Error)
 * @returns `{kind, retryable, prefix}` (object)
 */
export function classifyDriverError(error) {
  const code = error?.code;
  if (NETWORK_ERROR_NAMES.has(error?.name) || NETWORK_ERROR_CODES.has(code)) {
    return { kind: "network_error", retryable: true, prefix: "Cannot reach MongoDB" };
  }
  if (AUTH_ERROR_CODES.has(code) || error?.name === "MongoMissingCredentialsError") {
    return { kind: "auth_error", retryable: false, prefix: "MongoDB authentication failed" };
  }
  if (UNAUTHORIZED_CODES.has(code)) return { kind: "permission_denied", retryable: false, prefix: "MongoDB refused the operation" };
  if (MAX_TIME_EXPIRED_CODES.has(code) || error?.name === "MongoOperationTimeoutError") {
    return { kind: "timeout", retryable: true, prefix: "MongoDB operation exceeded max_time_ms" };
  }
  if (DUPLICATE_KEY_CODES.has(code)) return { kind: "conflict", retryable: false, prefix: "Duplicate key" };
  if (INPUT_ERROR_NAMES.has(error?.name) || INPUT_ERROR_CODES.has(code)) {
    return { kind: "invalid_input", retryable: false, prefix: "MongoDB rejected the request" };
  }
  if (error?.name === "AbortError") return { kind: "cancelled", retryable: false, prefix: "MongoDB operation cancelled" };
  return { kind: "database_error", retryable: false, prefix: "MongoDB error" };
}

/**
 * Reports a missing npm dependency as `setup_required`.
 *
 * @param importError - The failed import's error (Error)
 * @returns PluginError kind `setup_required`, or the original error when it is something else
 */
export function classifyImportError(importError) {
  const isMissing = importError?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(importError?.message ?? "");
  if (!isMissing) return importError;
  return setupRequired("The mongodb package is not installed: run `npm install` in the mongodb plugin directory");
}
