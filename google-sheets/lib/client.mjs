/**
 * Google Sheets API v4 client: base URL, Bearer auth (static token, refresh
 * trio or service account), Google error mapping and helpers shared by the
 * operation files.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { pathSegment } from "./shared/path.mjs";
import { createAccessTokenSource } from "./google-auth.mjs";
import { parseGoogleError } from "./google-errors.mjs";

export const SHEETS_BASE_URL = "https://sheets.googleapis.com/v4";
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const UNKNOWN_OUTCOME_MARKER = "outcome unknown";
const SPREADSHEET_URL_ID_PATTERN = /^https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([^/?#]+)/;

/**
 * Creates a Sheets client for the run's credentials.
 *
 * @param options - `{accessToken, fetchImpl}`; accessToken is the result of resolveGoogleCredentials (object)
 * @returns Shared API client `{request, requestWithHeaders}` (object)
 */
export function createSheetsClient({ accessToken: credentials, fetchImpl }) {
  const tokenSource = createAccessTokenSource(credentials, { scope: SHEETS_SCOPE, fetchImpl });
  return createApiClient({
    baseUrl: SHEETS_BASE_URL,
    authorize: async ({ headers }) => {
      headers.authorization = `Bearer ${await tokenSource.getAccessToken()}`;
    },
    refreshCredentials: tokenSource.refreshAccessToken,
    parseError: parseGoogleError,
    fetchImpl,
  });
}

/**
 * Builds `/spreadsheets/{id}/values/{range}` with an optional `:verb` suffix.
 *
 * @param spreadsheetId - Spreadsheet id (string)
 * @param a1Range - Range from buildA1Range (string)
 * @param verb - "append", "clear" or undefined (string, optional)
 * @returns API path (string)
 */
export function valuesPath(spreadsheetId, a1Range, verb) {
  return `${spreadsheetPath(spreadsheetId)}/values/${pathSegment(a1Range)}${verb ? `:${verb}` : ""}`;
}

/**
 * Builds `/spreadsheets/{id}`.
 *
 * @param spreadsheetId - Spreadsheet id, or a full docs.google.com spreadsheet URL (string)
 * @returns API path (string)
 */
export function spreadsheetPath(spreadsheetId) {
  return `/spreadsheets/${pathSegment(extractSpreadsheetId(spreadsheetId))}`;
}

/**
 * Returns the id from a spreadsheet URL (the part between /d/ and the next /), or the input unchanged.
 *
 * @param spreadsheetIdOrUrl - Spreadsheet id or URL (string)
 * @returns Spreadsheet id (string)
 *
 * @example
 * extractSpreadsheetId("https://docs.google.com/spreadsheets/d/1AbC/edit#gid=0"); // "1AbC"
 */
export function extractSpreadsheetId(spreadsheetIdOrUrl) {
  const urlMatch = SPREADSHEET_URL_ID_PATTERN.exec(String(spreadsheetIdOrUrl).trim());
  return urlMatch ? urlMatch[1] : spreadsheetIdOrUrl;
}

/**
 * Runs a write and, when its outcome is unknown, adds how to check before retrying.
 *
 * @param writePromise - The pending write request (Promise)
 * @param checkHint - How to verify, e.g. "read the sheet with read_range" (string)
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
 * Runs an idempotent write (e.g. clear) sent as POST: a failure whose outcome is unknown is made
 * retryable, because repeating it cannot change the result.
 *
 * @param writePromise - The pending write request (Promise)
 * @returns The write's result (Promise)
 * @throws PluginError - The original error; when its outcome was unknown, retryable and marked "safe to retry"
 */
export async function withIdempotentRetry(writePromise) {
  try {
    return await writePromise;
  } catch (writeError) {
    if (!(writeError instanceof PluginError) || !writeError.message.includes(UNKNOWN_OUTCOME_MARKER)) throw writeError;
    const message = `${writeError.message}. This write is idempotent: safe to retry`;
    throw new PluginError(message, { kind: writeError.kind, retryable: true, retryAfterMs: writeError.retryAfterMs });
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
