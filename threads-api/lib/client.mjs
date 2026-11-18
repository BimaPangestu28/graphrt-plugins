/**
 * Threads API client: base URL, Bearer auth, Graph-style error mapping,
 * token refresh and helpers shared by the operation files.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";

const THREADS_ORIGIN = "https://graph.threads.net";
export const THREADS_BASE_URL = `${THREADS_ORIGIN}/v1.0`;
const HOURLY_LIMIT_CODES = new Set([4, 17, 32, 613]);
const AUTH_ERROR_CODES = new Set([102, 190]);
const INVALID_INPUT_CODES = new Set([100]);
const OBJECT_DOES_NOT_EXIST_SUBCODE = 33;
const NOT_FOUND_CODES = new Set([24]);

/**
 * Creates a Threads API client for the given token.
 *
 * The token is always sent as a Bearer header. Any `access_token` a caller puts
 * in the query (e.g. through `api_request`) is dropped, so arguments can never
 * choose credentials.
 *
 * @param options - `{accessToken, fetchImpl}` (object)
 * @returns Shared API client plus `refreshAccessToken({signal})` (object)
 */
export function createThreadsClient({ accessToken, fetchImpl }) {
  const apiClient = createApiClient({
    baseUrl: THREADS_BASE_URL,
    authorize: ({ headers, query }) => {
      delete query.access_token;
      headers.authorization = `Bearer ${accessToken}`;
    },
    parseError: parseThreadsError,
    fetchImpl,
  });
  return { ...apiClient, refreshAccessToken: ({ signal } = {}) => requestTokenRefresh({ accessToken, fetchImpl, signal }) };
}

// The refresh endpoint is unversioned and takes the token as a query parameter, so it gets its own client.
function requestTokenRefresh({ accessToken, fetchImpl, signal }) {
  const refreshClient = createApiClient({
    baseUrl: THREADS_ORIGIN,
    authorize: ({ query }) => {
      query.access_token = accessToken;
    },
    parseError: parseThreadsError,
    fetchImpl,
  });
  return refreshClient.request({ path: "/refresh_access_token", query: { grant_type: "th_refresh_token" }, signal });
}

/**
 * Maps a Graph-style Threads error body to a message and error kind.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed response body (object)
 * @returns `{message, kind, retryable?}` or `{}` for non-Graph bodies; hourly limits are not retryable (object)
 */
export function parseThreadsError(status, body) {
  const graphError = body?.error;
  if (!graphError || typeof graphError !== "object") return {};
  const code = Number(graphError.code);
  const details = [
    Number.isFinite(code) && `code ${code}`,
    graphError.error_subcode && `subcode ${graphError.error_subcode}`,
    graphError.fbtrace_id && `fbtrace_id ${graphError.fbtrace_id}`,
  ].filter(Boolean);
  const baseMessage = graphError.error_user_msg || graphError.message || "Unknown Threads API error";
  const message = details.length > 0 ? `${baseMessage} (${details.join(", ")})` : baseMessage;
  const kind = kindForGraphError(code, Number(graphError.error_subcode), graphError.type, status);
  if (!HOURLY_LIMIT_CODES.has(code)) return { message, kind };
  // App/user limits are counted per rolling hour: a retry seconds later only spends more of the budget.
  return { message: `${message}. This is an hourly app/user rate limit; try again later (up to an hour)`, kind, retryable: false };
}

function kindForGraphError(code, subcode, errorType, status) {
  if (code === 100 && subcode === OBJECT_DOES_NOT_EXIST_SUBCODE) return "not_found";
  if (HOURLY_LIMIT_CODES.has(code)) return "rate_limited";
  if (AUTH_ERROR_CODES.has(code)) return "auth_error";
  if (code === 10 || (code >= 200 && code <= 299)) return "permission_denied";
  if (INVALID_INPUT_CODES.has(code)) return "invalid_input";
  if (NOT_FOUND_CODES.has(code)) return "not_found";
  if (errorType === "OAuthException" && status === 401) return "auth_error";
  return undefined;
}

/**
 * Converts a Graph list response into the operation output shape.
 *
 * @param responseBody - `{data, paging}` from the API (object)
 * @returns `{data, next_cursor}`; next_cursor only when the API reports a next page
 */
export function toPage(responseBody) {
  const hasNextPage = Boolean(responseBody?.paging?.next);
  return { data: responseBody?.data ?? [], next_cursor: hasNextPage ? (responseBody.paging.cursors?.after ?? null) : null };
}

/**
 * Builds the shared pagination parameters for list operations.
 *
 * @param defaultLimit - Default page size (number)
 * @returns JSON-schema properties `{limit, cursor}` (object)
 */
export function paginationProperties(defaultLimit = 25) {
  return {
    limit: { type: "integer", minimum: 1, maximum: 100, default: defaultLimit, description: "Page size (max 100)" },
    cursor: { type: "string", description: "next_cursor from a previous call" },
  };
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
