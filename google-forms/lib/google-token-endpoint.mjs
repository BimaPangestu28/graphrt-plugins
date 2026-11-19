/**
 * Google OAuth 2.0 token endpoint (https://oauth2.googleapis.com/token).
 *
 * Both credential flows end here: the refresh-token grant and the service
 * account JWT-bearer grant. The endpoint is a different origin from the API,
 * so it is called with its own fetch and never through the API client. Every
 * secret sent in the form (refresh token, client secret, signed assertion) is
 * redacted from error messages.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const TOKEN_REQUEST_TIMEOUT_MS = 30000;
const TOKEN_ERROR_KINDS = { 400: "auth_error", 401: "auth_error", 403: "permission_denied", 429: "rate_limited" };

/**
 * Posts a grant to Google's token endpoint and returns the access token.
 *
 * @param options - Request options (object)
 * @param options.form - Form fields, e.g. `{grant_type, refresh_token, ...}` (object)
 * @param options.secrets - Values to redact from errors (string[])
 * @param options.flowName - Used in error messages, e.g. "token refresh" (string)
 * @param fetchImpl - fetch implementation (function, default global fetch)
 * @returns `{accessToken, expiresAtMs}` (Promise<object>)
 * @throws PluginError kinds `auth_error` (rejected grant/client), `permission_denied`, `rate_limited`, `api_error`, `network_error`
 *
 * @example
 * await requestGoogleAccessToken({ form: { grant_type: "refresh_token", ... }, secrets: [refreshToken], flowName: "token refresh" });
 */
export async function requestGoogleAccessToken({ form, secrets, flowName }, fetchImpl = (...fetchArguments) => globalThis.fetch(...fetchArguments)) {
  let tokenResponse;
  try {
    tokenResponse = await fetchImpl(GOOGLE_TOKEN_URL, buildTokenRequest(form));
  } catch (fetchError) {
    const reason = describeFetchFailure(fetchError);
    throw new PluginError(redactSecrets(`Google ${flowName} failed: network error: ${reason}`, secrets), { kind: "network_error", retryable: true });
  }
  const responseBody = await readJsonBody(tokenResponse);
  if (!tokenResponse.ok) throw buildTokenEndpointError(tokenResponse.status, responseBody, { secrets, flowName });
  if (typeof responseBody.access_token !== "string" || responseBody.access_token === "") {
    throw new PluginError(`Google ${flowName} failed: the response has no access_token`, { kind: "api_error" });
  }
  const expiresInSeconds = Number(responseBody.expires_in) || DEFAULT_EXPIRES_IN_SECONDS;
  return { accessToken: responseBody.access_token, expiresAtMs: Date.now() + expiresInSeconds * 1000 };
}

// undici often reports "fetch failed" with the useful part (code, message) on `cause`, sometimes with an empty message.
function describeFetchFailure(fetchError) {
  if (fetchError?.name === "TimeoutError") return "request timed out";
  const details = [fetchError?.cause?.code, fetchError?.cause?.message, fetchError?.message].filter((detail) => typeof detail === "string" && detail !== "");
  return details.length > 0 ? [...new Set(details)].join(": ") : String(fetchError?.name ?? "unknown network failure");
}

function buildTokenRequest(form) {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  };
}

async function readJsonBody(tokenResponse) {
  const responseText = await tokenResponse.text();
  try {
    return responseText ? JSON.parse(responseText) : {};
  } catch {
    return { text: responseText };
  }
}

function buildTokenEndpointError(status, responseBody, { secrets, flowName }) {
  const errorCode = typeof responseBody.error === "string" ? responseBody.error : responseBody.error?.status;
  const description = responseBody.error_description ?? responseBody.error?.message ?? responseBody.text ?? "";
  const detail = [errorCode, description].filter(Boolean).join(": ");
  const kind = TOKEN_ERROR_KINDS[status] ?? "api_error";
  const message = redactSecrets(`Google ${flowName} failed (HTTP ${status}): ${detail || "no details"}`, secrets);
  return new PluginError(message, { kind, retryable: kind === "rate_limited" || status >= 500 });
}

/**
 * Replaces every secret (4+ characters) in a text with "[redacted]".
 *
 * @param text - Text that may contain secrets (string)
 * @param secrets - Secret values (string[])
 * @returns Redacted text (string)
 */
export function redactSecrets(text, secrets) {
  return secrets
    .filter((secretValue) => typeof secretValue === "string" && secretValue.length >= 4)
    .reduce((redactedText, secretValue) => redactedText.split(secretValue).join("[redacted]"), text);
}
