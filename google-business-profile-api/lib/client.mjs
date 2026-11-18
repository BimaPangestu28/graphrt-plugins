/**
 * Google Business Profile API clients. The Business Profile APIs live on four
 * hosts, so a run gets one shared-library client per host, all authorized by
 * one token source (one refresh for all of them):
 *
 * - account_management:   mybusinessaccountmanagement.googleapis.com/v1 (accounts)
 * - business_information: mybusinessbusinessinformation.googleapis.com/v1 (locations)
 * - my_business_v4:       mybusiness.googleapis.com/v4 (reviews, local posts)
 * - performance:          businessprofileperformance.googleapis.com/v1 (daily metrics)
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { createAccessTokenSource } from "./google-auth.mjs";
import { parseGoogleError } from "./google-errors.mjs";

export const BUSINESS_PROFILE_SCOPE = "https://www.googleapis.com/auth/business.manage";
export const BUSINESS_PROFILE_BASE_URLS = {
  account_management: "https://mybusinessaccountmanagement.googleapis.com/v1",
  business_information: "https://mybusinessbusinessinformation.googleapis.com/v1",
  my_business_v4: "https://mybusiness.googleapis.com/v4",
  performance: "https://businessprofileperformance.googleapis.com/v1",
};
const ZERO_QUOTA_HINT =
  " If every call fails like this, the project may still have 0 requests per minute: Business Profile API access must be approved by Google first.";
const UNKNOWN_OUTCOME_MARKER = "outcome unknown";

/**
 * Creates one client per Business Profile host for the run's credentials.
 *
 * @param options - `{accessToken, fetchImpl}`; accessToken is the result of resolveGoogleCredentials (object)
 * @returns `{account_management, business_information, my_business_v4, performance}` shared API clients (object)
 */
export function createBusinessProfileClients({ accessToken: credentials, fetchImpl }) {
  const tokenSource = createAccessTokenSource(credentials, { scope: BUSINESS_PROFILE_SCOPE, fetchImpl });
  const authorize = async ({ headers }) => {
    headers.authorization = `Bearer ${await tokenSource.getAccessToken()}`;
  };
  const buildClient = (baseUrl, clientFetch = fetchImpl) =>
    createApiClient({ baseUrl, authorize, refreshCredentials: tokenSource.refreshAccessToken, parseError: parseBusinessProfileError, fetchImpl: clientFetch });
  const hostClients = Object.fromEntries(Object.entries(BUSINESS_PROFILE_BASE_URLS).map(([hostKey, baseUrl]) => [hostKey, buildClient(baseUrl)]));
  const deleteResource = (hostKey, requestOptions) => deleteToleratingRetriedNotFound({ buildClient, fetchImpl, hostKey }, requestOptions);
  return { ...hostClients, deleteResource };
}

/**
 * Sends a DELETE that the shared client may retry after a 5xx or network failure. If an earlier attempt may have
 * applied the delete and a retry then gets 404, the resource is gone: report success instead of not_found.
 *
 * @param clientParts - `{buildClient, fetchImpl, hostKey}` (object)
 * @param requestOptions - `{path, signal}` (object)
 * @returns `{alreadyAbsent}` (Promise<object>)
 * @throws PluginError - Any other failure, or a 404 on the first attempt
 */
async function deleteToleratingRetriedNotFound({ buildClient, fetchImpl, hostKey }, requestOptions) {
  let hadUncertainAttempt = false;
  const observingFetch = async (...fetchArguments) => {
    try {
      const fetchResponse = await (fetchImpl ?? globalThis.fetch)(...fetchArguments);
      if (fetchResponse.status >= 500) hadUncertainAttempt = true;
      return fetchResponse;
    } catch (transportError) {
      hadUncertainAttempt = true;
      throw transportError;
    }
  };
  try {
    await buildClient(BUSINESS_PROFILE_BASE_URLS[hostKey], observingFetch).request({ ...requestOptions, method: "DELETE" });
    return { alreadyAbsent: false };
  } catch (deleteError) {
    if (deleteError instanceof PluginError && deleteError.kind === "not_found" && hadUncertainAttempt) return { alreadyAbsent: true };
    throw deleteError;
  }
}

/**
 * Maps a Google error body, adding the API-approval hint to quota errors.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed response body (object)
 * @returns `{message, kind}` or `{}` (object)
 */
export function parseBusinessProfileError(status, body) {
  const parsedError = parseGoogleError(status, body);
  if (parsedError.kind !== "rate_limited") return parsedError;
  return { ...parsedError, message: `${parsedError.message}.${ZERO_QUOTA_HINT}` };
}

/**
 * Converts a list response into `{data, next_cursor}`.
 *
 * @param items - Items of the page (Array | undefined)
 * @param nextPageToken - Token from the response (string | undefined)
 * @returns `{data, next_cursor}` (object)
 */
export function toPage(items, nextPageToken) {
  return { data: items ?? [], next_cursor: nextPageToken || null };
}

/**
 * Builds the shared pagination parameters for list operations.
 *
 * @param maximumLimit - API pageSize cap (number)
 * @param defaultLimit - Default page size (number)
 * @returns JSON-schema properties `{limit, cursor}` (object)
 */
export function paginationProperties(maximumLimit, defaultLimit) {
  return {
    limit: { type: "integer", minimum: 1, maximum: maximumLimit, default: defaultLimit, description: `Page size (max ${maximumLimit})` },
    cursor: { type: "string", description: "next_cursor from a previous call" },
  };
}

/**
 * Runs a write and, when its outcome is unknown, adds how to check before retrying.
 *
 * @param writePromise - The pending write request (Promise)
 * @param checkHint - How to verify, e.g. "call list_local_posts" (string)
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
 * Runs a write that is safe to resend (e.g. a PATCH with an update mask): a failure whose outcome is unknown is
 * made retryable, because sending it again leaves the same result.
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
