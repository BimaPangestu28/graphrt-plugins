/**
 * Declarative error mapping for REST plugins: turns an `errors` spec into the shared client's `parseError` and
 * `detectBodyError` hooks.
 *
 * Spec fields (all optional):
 *   messagePath   - path or list of paths to the message, first non-empty string wins ("error.message")
 *   codePath      - path to the API's error code ("error.code"); shown in the message and used for kindByCode
 *   kindByCode    - {code: kind}, e.g. {unauthorized: "auth_error", rate_limited: "rate_limited"}
 *   kindByStatus  - {status: kind}, for unusual statuses (e.g. {529: "rate_limited"})
 *   retryableCodes - codes that mean "nothing was applied, safe to retry"
 *   retryAfterPath - path to a retry hint in the body, in `retryAfterUnit` ("seconds" by default)
 *   okPath/okValue - error-in-2xx: a 2xx body whose okPath holds a defined value other than okValue (default true)
 *   errorPath      - error-in-2xx: a 2xx body with a truthy value at errorPath
 */
import { readPath } from "./object-path.mjs";

/**
 * Builds the client's `parseError(status, body)` hook.
 *
 * @param errors - `errors` spec (object, optional)
 * @returns `(status, body) => {message?, kind?, retryAfterMs?, retryable?}` (function)
 *
 * @example
 * createErrorParser({ messagePath: "error.message", codePath: "error.code", kindByCode: { expired: "auth_error" } })(
 *   401, { error: { message: "Token expired", code: "expired" } }); // { message: "Token expired (expired)", kind: "auth_error" }
 */
export function createErrorParser(errors = {}) {
  return (status, body) => {
    const parsedError = describeBodyError(errors, body);
    const statusKind = errors.kindByStatus?.[status];
    if (!parsedError.kind && statusKind) parsedError.kind = statusKind;
    return parsedError;
  };
}

/**
 * Builds the client's `detectBodyError(body)` hook for APIs that report errors in 2xx bodies.
 *
 * @param errors - `errors` spec (object, optional)
 * @returns Hook, or undefined when no okPath/errorPath is declared (function | undefined)
 */
export function createBodyErrorDetector(errors = {}) {
  if (errors.okPath === undefined && errors.errorPath === undefined) return undefined;
  return (body) => {
    if (!body || typeof body !== "object" || !isErrorBody(errors, body)) return null;
    const bodyError = describeBodyError(errors, body);
    return { ...bodyError, message: bodyError.message ?? fallbackMessage(errors, body), kind: bodyError.kind ?? "api_error" };
  };
}

function isErrorBody(errors, body) {
  if (errors.okPath !== undefined) {
    const okFieldValue = readPath(body, errors.okPath);
    if (okFieldValue !== undefined && okFieldValue !== (errors.okValue ?? true)) return true;
  }
  return errors.errorPath !== undefined && Boolean(readPath(body, errors.errorPath));
}

function describeBodyError(errors, body) {
  if (!body || typeof body !== "object") return {};
  const code = errors.codePath ? readPath(body, errors.codePath) : undefined;
  const message = findMessage(errors, body);
  const parsedError = {};
  if (message) parsedError.message = code === undefined || code === null ? message : `${message} (${code})`;
  const codeKind = code === undefined ? undefined : errors.kindByCode?.[code];
  if (codeKind) parsedError.kind = codeKind;
  if (code !== undefined && errors.retryableCodes?.map(String).includes(String(code))) parsedError.retryable = true;
  const retryAfterMs = readRetryAfterMs(errors, body);
  if (retryAfterMs !== undefined) parsedError.retryAfterMs = retryAfterMs;
  return parsedError;
}

function findMessage(errors, body) {
  const messagePaths = [errors.messagePath ?? []].flat();
  return messagePaths.map((messagePath) => readPath(body, messagePath)).find((candidate) => typeof candidate === "string" && candidate !== "");
}

function fallbackMessage(errors, body) {
  const errorValue = errors.errorPath ? readPath(body, errors.errorPath) : undefined;
  if (typeof errorValue === "string") return errorValue;
  return errorValue && typeof errorValue === "object" ? JSON.stringify(errorValue).slice(0, 500) : "the API reported an error in a successful response";
}

function readRetryAfterMs(errors, body) {
  if (!errors.retryAfterPath) return undefined;
  const retryAfter = Number(readPath(body, errors.retryAfterPath));
  if (!Number.isFinite(retryAfter) || retryAfter < 0) return undefined;
  return errors.retryAfterUnit === "milliseconds" ? retryAfter : retryAfter * 1000;
}
