/**
 * Constants and small checks shared by the declarative REST spec validators and the runtime
 * (rest-spec-validation.mjs, rest-operation-validation.mjs, rest-plugin.mjs).
 */

export const PARAM_LOCATIONS = ["path", "query", "body", "header"];
export const PARAM_TYPES = ["string", "integer", "number", "boolean", "array", "object"];
export const WRITE_CLASSES = ["read", "idempotent", "unsafe"];
export const BODY_MODES = ["json", "form", "raw", "text", "multipart", "file"];
export const QUERY_ARRAY_STYLES = ["comma", "repeat", "brackets"];
export const FORM_ARRAY_STYLES = ["brackets", "repeat", "indexed"];
export const ERROR_KINDS = ["invalid_input", "auth_error", "permission_denied", "not_found", "rate_limited", "api_error", "network_error", "timeout"];
export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
export const READ_METHODS = new Set(["GET", "HEAD"]);
export const PAGINATION_PARAM_NAMES = ["limit", "cursor"];
export const JOB_WAIT_PARAM = "wait";
export const TOOL_POLICY_PATTERN = /^optIn:([A-Z][A-Z0-9_]*)$/;
export const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export const DEFAULT_HOST_TIMEOUT_MS = 120000;
/** A request may use the host timeout minus the tool-deadline margin (operations.mjs). */
export const REQUEST_TIMEOUT_MARGIN_MS = 10000;
/** The shared client's default per-attempt timeout (api-client.mjs). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
/** A job must report its timeout (with the job id) before the tool deadline. */
export const JOB_TIMEOUT_MARGIN_MS = 15000;
export const MIN_JOB_BUDGET_MS = 5000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PLACEHOLDER_PATTERN = /\{(\+?)([^{}+]+)\}/g;
const PAGINATION_STYLE_FIELDS = [
  ["cursor", "cursorPath"],
  ["link", "nextLinkHeader"],
  ["nextUrl", "nextUrlPath"],
  ["lastItem", "lastItemCursor"],
  ["page", "pagePagination"],
  ["offset", "offsetPagination"],
];
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const TOOL_OUTPUT_KEYS = ["maxItems", "maxChars"];

/**
 * Lists the `{name}` and `{+name}` placeholders in a path template.
 *
 * @param pathTemplate - e.g. "/repos/{owner}/contents/{+file_path}" (string)
 * @returns `[{name, multiSegment}]` (object[])
 */
export function listPlaceholders(pathTemplate) {
  return [...pathTemplate.matchAll(PLACEHOLDER_PATTERN)].map((match) => ({ name: match[2], multiSegment: match[1] === "+" }));
}

/**
 * Names the pagination styles a response spec declares.
 *
 * @param response - Operation `response` spec (object, optional)
 * @returns Style names: cursor, link, nextUrl, lastItem, page, offset (string[])
 */
export function paginationStyles(response) {
  if (!response) return [];
  return PAGINATION_STYLE_FIELDS.filter(([, fieldName]) => response[fieldName]).map(([style]) => style);
}

/**
 * The API names that the generated `limit` and `cursor` are sent as.
 *
 * @param response - Operation `response` spec (object)
 * @returns `{limitWireName, cursorWireName}`; either may be undefined (object)
 */
export function describePaginationWireNames(response) {
  const limitWireName = response.limitParam ?? response.pagePagination?.sizeParam ?? response.offsetPagination?.limitParam;
  const cursorWireName = response.cursorParam ?? response.lastItemCursor?.param ?? response.pagePagination?.pageParam ?? response.offsetPagination?.offsetParam;
  return { limitWireName, cursorWireName };
}

/**
 * Time budgets derived from the manifest's `limits.timeout_ms`.
 *
 * @param limits - Plugin `limits` (object, optional)
 * @returns `{hostTimeoutMs, requestTimeoutCapMs, jobBudgetCapMs}` (object)
 */
export function describeTimeBudgets(limits) {
  const hostTimeoutMs = limits?.timeout_ms ?? DEFAULT_HOST_TIMEOUT_MS;
  return { hostTimeoutMs, requestTimeoutCapMs: hostTimeoutMs - REQUEST_TIMEOUT_MARGIN_MS, jobBudgetCapMs: hostTimeoutMs - JOB_TIMEOUT_MARGIN_MS };
}

/**
 * Checks a base URL: https (http only on localhost) and, when given, a host under `allowedHostSuffix`.
 *
 * @param baseUrl - Candidate URL (string)
 * @param fail - `(problem) => never` (function)
 * @param allowedHostSuffix - e.g. ".atlassian.net" (string, optional)
 * @returns Nothing
 */
export function checkBaseUrl(baseUrl, fail, allowedHostSuffix) {
  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return fail(`\`baseUrl\` ${JSON.stringify(baseUrl)} is not a valid URL`);
  }
  const isLocalHttp = parsedUrl.protocol === "http:" && LOCAL_HOSTS.has(parsedUrl.hostname);
  if (parsedUrl.protocol !== "https:" && !isLocalHttp) fail(`\`baseUrl\` ${baseUrl} must use https (http only on localhost)`);
  if (parsedUrl.username || parsedUrl.password) fail(`\`baseUrl\` ${baseUrl} must not contain credentials`);
  if (allowedHostSuffix && !parsedUrl.hostname.toLowerCase().endsWith(allowedHostSuffix.toLowerCase())) {
    fail(`\`baseUrl\` host ${parsedUrl.hostname} is not under allowedHostSuffix ${allowedHostSuffix}`);
  }
}

/**
 * Throws through `fail` for keys outside `allowedKeys`.
 *
 * @param candidate - Object to check (object)
 * @param allowedKeys - Allowed key names (string[])
 * @param where - Label for messages (string)
 * @param fail - `(problem) => never` (function)
 * @returns Nothing
 */
export function rejectUnknownKeys(candidate, allowedKeys, where, fail) {
  if (!candidate || typeof candidate !== "object") fail(`${where} must be an object`);
  for (const key of Object.keys(candidate)) {
    if (!allowedKeys.includes(key)) fail(`${where}: unknown key \`${key}\` (allowed: ${allowedKeys.join(", ")})`);
  }
}

/**
 * Requires a non-empty string.
 *
 * @param value - Candidate (any)
 * @param label - Label for messages (string)
 * @param fail - `(problem) => never` (function)
 * @returns Nothing
 */
export function requireText(value, label, fail) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
}

/**
 * Requires an UPPER_SNAKE_CASE environment variable name.
 *
 * @param envName - Candidate (any)
 * @param label - Label for messages (string)
 * @param fail - `(problem) => never` (function)
 * @returns Nothing
 */
export function checkEnvName(envName, label, fail) {
  if (typeof envName !== "string" || !ENV_NAME.test(envName)) fail(`${label} must be an UPPER_SNAKE_CASE environment variable name`);
}

/**
 * Requires a valid HTTP header name.
 *
 * @param headerName - Candidate (any)
 * @param label - Label for messages (string)
 * @param fail - `(problem) => never` (function)
 * @returns Nothing
 */
export function checkHeaderName(headerName, label, fail) {
  if (typeof headerName !== "string" || !HEADER_NAME_PATTERN.test(headerName)) fail(`${label} ${JSON.stringify(headerName)} is not a valid header name`);
}

/**
 * Validates a `toolOutput` setting: false, or `{maxItems?, maxChars?}` with positive integers.
 *
 * @param toolOutput - Setting (object | false | undefined)
 * @param label - Label for messages (string)
 * @param fail - `(problem) => never` (function)
 * @returns Nothing
 */
export function validateToolOutput(toolOutput, label, fail) {
  if (toolOutput === undefined || toolOutput === false) return;
  rejectUnknownKeys(toolOutput, TOOL_OUTPUT_KEYS, label, fail);
  for (const key of TOOL_OUTPUT_KEYS) {
    if (toolOutput[key] !== undefined && !(Number.isInteger(toolOutput[key]) && toolOutput[key] > 0)) fail(`${label}.${key} must be a positive integer`);
  }
}

/**
 * Checks a per-attempt request timeout against the host timeout.
 *
 * @param timeoutMs - Timeout (number, optional)
 * @param limits - Plugin `limits` (object, optional)
 * @param label - Label for messages (string)
 * @param fail - `(problem) => never` (function)
 * @returns Nothing
 */
export function validateRequestTimeout(timeoutMs, limits, label, fail) {
  if (timeoutMs === undefined) return;
  const { hostTimeoutMs, requestTimeoutCapMs } = describeTimeBudgets(limits);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) fail(`${label} must be a positive integer`);
  if (timeoutMs > requestTimeoutCapMs) fail(`${label} ${timeoutMs} does not fit in limits.timeout_ms ${hostTimeoutMs} minus 10 s; raise limits.timeout_ms`);
}
