/**
 * BigQuery API v2 client: base URL, Bearer auth from the Google credentials (static token, refresh trio or service
 * account, see google-auth.mjs) and Google error mapping, plus the run's settings.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { createAccessTokenSource } from "./google-auth.mjs";
import { parseGoogleError } from "./google-errors.mjs";
import { resolveSettings } from "./settings.mjs";

export const BIGQUERY_BASE_URL = "https://bigquery.googleapis.com/bigquery/v2";
export const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/bigquery";
const BYTES_BILLED_REASON = "bytesBilledLimitExceeded";

/**
 * Maps BigQuery errors: Google's format, plus a hint when the bytes-billed cap stopped a query.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed body (object)
 * @returns `{message, kind}` for the shared client (object)
 */
export function parseBigQueryError(status, body) {
  const parsed = parseGoogleError(status, body);
  const reasons = (body?.error?.errors ?? []).map((errorDetail) => errorDetail?.reason);
  if (!reasons.includes(BYTES_BILLED_REASON)) return parsed;
  return { message: `${parsed.message}. The query would bill more than maximum_bytes_billed: narrow it (partitions, fewer columns) or raise the limit up to BIGQUERY_MAX_BYTES_BILLED`, kind: "invalid_input" };
}

/**
 * Creates the client the operations receive.
 *
 * @param runnerInputs - `{accessToken, environment, fetchImpl}`; accessToken is the result of resolveGoogleCredentials (object)
 * @returns Shared API client `{request, requestWithHeaders}` plus `settings` (object)
 * @throws PluginError kind `invalid_input` - When a setting is malformed
 */
export function createBigQueryClient({ accessToken: credentials, environment, fetchImpl }) {
  const settings = resolveSettings(environment);
  const tokenSource = createAccessTokenSource(credentials, { scope: BIGQUERY_SCOPE, fetchImpl });
  const apiClient = createApiClient({
    baseUrl: BIGQUERY_BASE_URL,
    authorize: async ({ headers }) => {
      headers.authorization = `Bearer ${await tokenSource.getAccessToken()}`;
    },
    refreshCredentials: tokenSource.refreshAccessToken,
    parseError: parseBigQueryError,
    fetchImpl,
  });
  return { ...apiClient, settings };
}
