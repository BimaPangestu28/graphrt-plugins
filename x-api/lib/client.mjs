/**
 * X API v2 client: base URL, Bearer auth (OAuth 2.0 user token), X error
 * mapping (RFC 7807 problems and legacy `errors[]`), pagination and the
 * authenticated-user id lookup shared by the operation files.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const X_API_ORIGIN = "https://api.x.com";
const NUMERIC_ID_PATTERN = /^[0-9]{1,19}$/;
const RATE_LIMIT_PROBLEMS = new Set(["usage-capped", "rate-limit-exceeded", "dm-rate-limited"]);
const AUTH_PROBLEMS = new Set(["unsupported-authentication"]);
const PERMISSION_PROBLEMS = new Set([
  "not-authorized-for-resource",
  "not-authorized-for-field",
  "field-unauthorized",
  "client-forbidden",
  "disallowed-resource",
  "recipient-not-messageable",
]);
const NOT_FOUND_PROBLEMS = new Set(["resource-not-found", "dm-conversation-not-found", "dm-not-found", "dm-recipient-not-found", "dm-participant-not-found"]);
const INVALID_INPUT_PROBLEMS = new Set(["invalid-request", "dm-text-empty", "dm-text-too-long", "dm-duplicate", "dm-unsupported-message"]);
const LEGACY_CODE_KINDS = { 32: "auth_error", 88: "rate_limited", 89: "auth_error", 185: "rate_limited", 187: "invalid_input" };

/**
 * Creates the X client for one operation run.
 *
 * The returned object is the shared API client plus `fetchImpl` (used for
 * credential-free downloads and the token endpoint) and a per-run cache for
 * the authenticated user's id.
 *
 * @param options - `{accessToken, environment, fetchImpl}` (object)
 * @returns `{request, requestWithHeaders, fetchImpl, environment, userIdCache}` (object)
 */
export function createXClient({ accessToken, environment, fetchImpl }) {
  const apiClient = createApiClient({
    baseUrl: X_API_ORIGIN,
    authorize: ({ headers }) => {
      if (!accessToken) throw missingTokenError();
      headers.authorization = `Bearer ${accessToken}`;
    },
    parseError: parseXError,
    detectBodyError: detectXBodyError,
    fetchImpl,
  });
  return { ...apiClient, fetchImpl: fetchImpl ?? ((...fetchArguments) => globalThis.fetch(...fetchArguments)), environment, userIdCache: {} };
}

/**
 * Picks the token without failing when it is missing, so `refresh_access_token`
 * works without X_ACCESS_TOKEN; other operations fail in `authorize` instead.
 *
 * @param options - `{environment, nodeToken}` (object)
 * @returns The token, or null (string | null)
 */
export function resolveXAccessToken({ environment, nodeToken }) {
  return nodeToken || environment?.X_ACCESS_TOKEN || null;
}

function missingTokenError() {
  return new PluginError(
    "No access token: set the X_ACCESS_TOKEN environment variable (and allow it in permissions.env) or pass `access_token` on the node",
    { kind: "auth_error" },
  );
}

/**
 * Maps an X error response to a message, error kind and retry delay.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed response body (object)
 * @param headers - Response headers (Headers)
 * @returns `{message, kind, retryAfterMs}`, or `{}` for bodies that are not X errors (object)
 */
export function parseXError(status, body, headers) {
  const firstError = Array.isArray(body?.errors) ? body.errors[0] : undefined;
  const problemName = readProblemName(body?.type) ?? readProblemName(firstError?.type);
  const message = describeXError(body, firstError);
  if (!message && !problemName && status !== 429) return {};
  const kind = kindForProblem(problemName) ?? LEGACY_CODE_KINDS[firstError?.code] ?? kindForStatus(status);
  const retryAfterMs = kind === "rate_limited" ? readRateLimitResetMs(headers) : undefined;
  // The monthly usage cap cannot clear within a retry window; retrying would only add billed calls.
  const retryable = problemName === "usage-capped" ? false : undefined;
  return { message: message ?? problemName ?? "Too Many Requests", kind, retryAfterMs, retryable };
}

/**
 * Detects an error reported inside a 2xx body: X returns 200 with only
 * `errors[]` when, for example, the requested post does not exist. A body
 * that has both `data` and `errors` is a partial success and is not an error.
 *
 * @param body - Parsed response body (object)
 * @param headers - Response headers (Headers)
 * @returns `{message, kind, retryAfterMs}` or null (object | null)
 */
export function detectXBodyError(body, headers) {
  const hasErrors = Array.isArray(body?.errors) && body.errors.length > 0;
  if (!hasErrors || body.data != null) return null;
  const parsedError = parseXError(200, body, headers);
  return { message: parsedError.message ?? "X returned errors and no data", kind: parsedError.kind ?? "api_error", retryAfterMs: parsedError.retryAfterMs };
}

function readProblemName(problemType) {
  if (typeof problemType !== "string") return undefined;
  const problemMatch = problemType.match(/\/2\/problems\/([a-z-]+)$/);
  return problemMatch ? problemMatch[1] : undefined;
}

function describeXError(body, firstError) {
  const topLevelDetail = body?.detail || body?.title;
  const parts = [topLevelDetail, firstError?.detail, firstError?.message].filter((part) => typeof part === "string" && part !== "");
  return parts.length > 0 ? [...new Set(parts)].join(": ") : undefined;
}

function kindForProblem(problemName) {
  if (!problemName) return undefined;
  if (RATE_LIMIT_PROBLEMS.has(problemName)) return "rate_limited";
  if (AUTH_PROBLEMS.has(problemName)) return "auth_error";
  if (NOT_FOUND_PROBLEMS.has(problemName)) return "not_found";
  if (INVALID_INPUT_PROBLEMS.has(problemName) || problemName.startsWith("dm-bad-") || problemName.startsWith("dm-too-")) return "invalid_input";
  if (PERMISSION_PROBLEMS.has(problemName) || /^dm-(recipient|sender|participant)-/.test(problemName)) return "permission_denied";
  return undefined;
}

function kindForStatus(status) {
  if (status === 401) return "auth_error";
  if (status === 429) return "rate_limited";
  return undefined;
}

function readRateLimitResetMs(headers) {
  const resetSeconds = Number(headers?.get?.("x-rate-limit-reset"));
  if (!Number.isFinite(resetSeconds) || resetSeconds <= 0) return undefined;
  return Math.max(0, resetSeconds * 1000 - Date.now());
}

/**
 * Converts an X list response into the operation output shape. The whole X
 * body is kept as `data` so `includes` (expansions) and partial `errors` survive.
 *
 * @param responseBody - `{data, includes, meta, errors}` from X (object)
 * @returns `{data, next_cursor}` with next_cursor from `meta.next_token` (object)
 */
export function toPage(responseBody) {
  return { data: responseBody ?? {}, next_cursor: responseBody?.meta?.next_token ?? null };
}

/**
 * Returns the authenticated user's id: X_USER_ID when set, otherwise one
 * GET /2/users/me per operation run (cached on the client).
 *
 * @param client - Client from createXClient (object)
 * @param signal - Cancellation signal (AbortSignal, optional)
 * @returns The numeric user id (Promise<string>)
 * @throws PluginError kind `invalid_input` (malformed X_USER_ID), `api_error` (no id in /2/users/me)
 */
export async function resolveAuthenticatedUserId(client, signal) {
  const configuredUserId = client.environment?.X_USER_ID;
  if (configuredUserId) {
    if (!NUMERIC_ID_PATTERN.test(configuredUserId)) rejectInput(`X_USER_ID must be a numeric user id, got "${configuredUserId}"`);
    return configuredUserId;
  }
  client.userIdCache.userId ??= await fetchAuthenticatedUserId(client, signal);
  return client.userIdCache.userId;
}

async function fetchAuthenticatedUserId(client, signal) {
  const meResponse = await client.request({ path: "/2/users/me", signal });
  const userId = meResponse?.data?.id;
  if (!userId) throw new PluginError("Could not resolve the authenticated user id from /2/users/me", { kind: "api_error" });
  return String(userId);
}

/**
 * Throws invalid_input with a message.
 *
 * @param message - What is wrong (string)
 * @throws PluginError kind `invalid_input`
 */
export function rejectInput(message) {
  throw new PluginError(message, { kind: "invalid_input" });
}
