/**
 * Google Calendar API v3 client: base URL, Bearer auth (static token, refresh trio or service
 * account), Calendar-specific error kinds and path helpers shared by the operation files.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { pathSegment } from "./shared/path.mjs";
import { createAccessTokenSource } from "./google-auth.mjs";
import { parseGoogleError } from "./google-errors.mjs";

export const CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const UNKNOWN_OUTCOME_MARKER = "outcome unknown";

/**
 * Creates a Calendar client for the run's credentials.
 *
 * @param options - `{accessToken, fetchImpl}`; accessToken is the result of resolveGoogleCredentials (object)
 * @returns Shared API client `{request, requestWithHeaders}` (object)
 */
export function createCalendarClient({ accessToken: credentials, fetchImpl }) {
  const tokenSource = createAccessTokenSource(credentials, { scope: CALENDAR_SCOPE, fetchImpl });
  return createApiClient({
    baseUrl: CALENDAR_BASE_URL,
    authorize: async ({ headers }) => {
      headers.authorization = `Bearer ${await tokenSource.getAccessToken()}`;
    },
    refreshCredentials: tokenSource.refreshAccessToken,
    parseError: parseCalendarError,
    fetchImpl,
  });
}

/**
 * Maps Calendar error bodies: the generic Google mapping plus Calendar's own reasons.
 * 409 `duplicate` (an event id already exists) becomes `already_exists`, 410 `deleted` becomes
 * `already_deleted`, 412 becomes `conflict` and 403 `quotaExceeded` (daily quota) becomes a
 * non-retryable `rate_limited`.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed response body (object)
 * @returns `{message?, kind?, retryable?}` (object)
 */
export function parseCalendarError(status, body) {
  const parsedError = parseGoogleError(status, body);
  const reason = readFirstReason(body);
  if (status === 409 && reason === "duplicate") return { ...parsedError, kind: "already_exists", retryable: false };
  if (status === 410 && reason === "deleted") return { ...parsedError, kind: "already_deleted", retryable: false };
  if (status === 412) return { ...parsedError, kind: "conflict", retryable: false };
  if (reason === "quotaExceeded") return { ...parsedError, kind: "rate_limited", retryable: false };
  return parsedError;
}

function readFirstReason(body) {
  const googleError = body?.error;
  if (!googleError || typeof googleError !== "object") return undefined;
  return googleError.errors?.[0]?.reason ?? googleError.details?.find((detail) => typeof detail?.reason === "string")?.reason;
}

/**
 * Builds `/calendars/{calendarId}`.
 *
 * @param calendarId - Calendar id or "primary" (string)
 * @returns API path (string)
 */
export function calendarPath(calendarId) {
  return `/calendars/${pathSegment(calendarId)}`;
}

/**
 * Builds `/calendars/{calendarId}/events/{eventId}`.
 *
 * @param calendarId - Calendar id (string)
 * @param eventId - Event id (string)
 * @returns API path (string)
 */
export function eventPath(calendarId, eventId) {
  return `${calendarPath(calendarId)}/events/${pathSegment(eventId)}`;
}

/**
 * Appends a repeated query parameter (`name=a&name=b`); the shared client joins arrays with commas instead.
 *
 * @param path - API path without a query (string)
 * @param parameterName - Query name (string)
 * @param parameterValues - Values (string[])
 * @returns Path with the query string, or the path unchanged when there are no values (string)
 */
export function appendRepeatedQuery(path, parameterName, parameterValues) {
  if (parameterValues.length === 0) return path;
  const queryString = new URLSearchParams(parameterValues.map((parameterValue) => [parameterName, parameterValue])).toString();
  return `${path}?${queryString}`;
}

/**
 * Runs a write and, when its outcome is unknown, adds how to check before retrying.
 *
 * @param writePromise - The pending write request (Promise)
 * @param checkHint - How to verify, e.g. "call list_events for that day" (string)
 * @returns The write's result (Promise)
 * @throws PluginError - The original error, with the hint appended and retryable false when the outcome is unknown
 */
export async function withWriteOutcomeHint(writePromise, checkHint) {
  try {
    return await writePromise;
  } catch (writeError) {
    if (!(writeError instanceof PluginError) || !writeError.message.includes(UNKNOWN_OUTCOME_MARKER)) throw writeError;
    throw new PluginError(`${writeError.message}. To check: ${checkHint}`, { kind: writeError.kind, retryable: false });
  }
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
