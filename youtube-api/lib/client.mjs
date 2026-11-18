/**
 * YouTube Data API v3 client: base URL, Bearer auth (static token or the
 * refresh trio), Google error mapping and helpers shared by the operation files.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { createAccessTokenSource } from "./oauth.mjs";

export const YOUTUBE_BASE_URL = "https://www.googleapis.com/youtube/v3";
const DAILY_QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded"]);
const SHORT_RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
const PERMISSION_REASONS = new Set(["commentsDisabled", "forbidden", "insufficientPermissions"]);
const AUTH_REASONS = new Set(["authorizationRequired"]);
// The shared client does not pass the request's signal to authorize/refreshCredentials, so it travels here.
const requestSignalStorage = new AsyncLocalStorage();

/**
 * Creates a YouTube client for the run's credentials.
 *
 * @param options - `{accessToken, fetchImpl}`; accessToken is the result of resolveYouTubeCredentials (object)
 * @returns Shared API client `{request, requestWithHeaders}` (object)
 */
export function createYouTubeClient({ accessToken: credentials, fetchImpl }) {
  const tokenSource = createAccessTokenSource(credentials, fetchImpl);
  const apiClient = createApiClient({
    baseUrl: YOUTUBE_BASE_URL,
    authorize: async ({ headers }) => {
      headers.authorization = `Bearer ${await tokenSource.getAccessToken(requestSignalStorage.getStore())}`;
    },
    refreshCredentials: () => tokenSource.refreshAccessToken(requestSignalStorage.getStore()),
    parseError: parseYouTubeError,
    fetchImpl,
  });
  const runWithRequestSignal = (send) => (requestOptions) =>
    requestSignalStorage.run(requestOptions?.signal, () => send(requestOptions)).catch((requestError) => {
      throw addPartialRefreshHint(requestError, credentials.partialRefreshHint);
    });
  return { request: runWithRequestSignal(apiClient.request), requestWithHeaders: runWithRequestSignal(apiClient.requestWithHeaders) };
}

// A rejected YOUTUBE_ACCESS_TOKEN next to an incomplete refresh trio would otherwise fail without saying why no refresh happened.
function addPartialRefreshHint(requestError, partialRefreshHint) {
  if (!partialRefreshHint || requestError?.kind !== "auth_error") return requestError;
  return new PluginError(`${requestError.message} (YOUTUBE_ACCESS_TOKEN was rejected and the ${partialRefreshHint})`, {
    kind: requestError.kind,
    retryable: requestError.retryable,
    retryAfterMs: requestError.retryAfterMs,
  });
}

/**
 * Maps a Google API error body (`{error: {code, message, errors: [{reason}]}}`) to a message and kind.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed response body (object)
 * @returns `{message, kind, retryable?}`, or `{}` for non-Google bodies (object)
 */
export function parseYouTubeError(status, body) {
  const googleError = body?.error;
  if (!googleError || typeof googleError !== "object") return {};
  const reason = googleError.errors?.[0]?.reason;
  const message = reason ? `${googleError.message} (reason ${reason})` : googleError.message;
  if (DAILY_QUOTA_REASONS.has(reason)) {
    // The daily quota cannot clear within a retry window, so never retry it.
    return { message: `${message}. The YouTube quota resets daily at midnight Pacific Time.`, kind: "rate_limited", retryable: false };
  }
  return { message, kind: kindForReason(reason) };
}

function kindForReason(reason) {
  if (typeof reason !== "string") return undefined;
  if (SHORT_RATE_LIMIT_REASONS.has(reason)) return "rate_limited";
  if (PERMISSION_REASONS.has(reason)) return "permission_denied";
  if (AUTH_REASONS.has(reason)) return "auth_error";
  if (/notFound$/i.test(reason)) return "not_found";
  return undefined;
}

/**
 * Converts a YouTube list response into the operation output shape.
 *
 * @param responseBody - `{items, nextPageToken}` (object)
 * @returns `{data, next_cursor}` (object)
 */
export function toPage(responseBody) {
  return { data: responseBody?.items ?? [], next_cursor: responseBody?.nextPageToken ?? null };
}

/**
 * Builds the shared pagination parameters for list operations.
 *
 * @param maximumLimit - API maxResults cap (number)
 * @param defaultLimit - Default page size (number)
 * @returns JSON-schema properties `{limit, cursor}` (object)
 */
export function paginationProperties(maximumLimit, defaultLimit = 20) {
  return {
    limit: { type: "integer", minimum: 1, maximum: maximumLimit, default: defaultLimit, description: `Page size (max ${maximumLimit})` },
    cursor: { type: "string", description: "next_cursor from a previous call" },
  };
}

/**
 * Returns the first item of a list response or fails with not_found.
 *
 * @param responseBody - `{items}` (object)
 * @param missingMessage - Error message when there is no item (string)
 * @returns The first item (object)
 * @throws PluginError kind `not_found`
 */
export function requireFirstItem(responseBody, missingMessage) {
  const firstItem = responseBody?.items?.[0];
  if (!firstItem) rejectNotFound(missingMessage);
  return firstItem;
}

/**
 * Throws not_found with a message.
 *
 * @param message - What is missing (string)
 * @throws PluginError kind `not_found`
 */
export function rejectNotFound(message) {
  throw new PluginError(message, { kind: "not_found" });
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
