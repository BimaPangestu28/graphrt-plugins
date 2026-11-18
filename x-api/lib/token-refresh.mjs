/**
 * OAuth 2.0 refresh-token grant against X's token endpoint.
 *
 * Uses its own API client without the Bearer token: the user's access token
 * must not be sent to the token endpoint, and an expired one must not block
 * refreshing. Confidential clients authenticate with Basic auth from the
 * X_CLIENT_SECRET env var; public (PKCE) clients send only client_id.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { X_API_ORIGIN } from "./client.mjs";

/**
 * Exchanges a refresh token for new tokens. X rotates refresh tokens, so the
 * caller must store the returned `refresh_token`.
 *
 * @param options - Refresh options (object)
 * @param options.fetchImpl - fetch implementation (function)
 * @param options.environment - Environment variables; reads X_CLIENT_SECRET (object)
 * @param options.refreshToken - Current refresh token (string)
 * @param options.clientId - OAuth 2.0 client id (string)
 * @param options.signal - Cancellation signal (AbortSignal, optional)
 * @returns Token response `{token_type, expires_in, access_token, refresh_token, scope}` (Promise<object>)
 * @throws PluginError kinds `auth_error` (rejected grant), `api_error` (no access_token in the response)
 */
export async function refreshAccessToken({ fetchImpl, environment, refreshToken, clientId, signal }) {
  const authorizeTokenRequest = createTokenRequestAuthorizer({ clientId, clientSecret: environment?.X_CLIENT_SECRET, refreshToken });
  const tokenClient = createApiClient({ baseUrl: X_API_ORIGIN, authorize: authorizeTokenRequest, parseError: parseTokenError, fetchImpl });
  const form = { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId };
  const tokenResponse = await tokenClient.request({ method: "POST", path: "/2/oauth2/token", form, signal });
  if (!tokenResponse?.access_token) throw new PluginError("X's token endpoint returned no access_token", { kind: "api_error" });
  return tokenResponse;
}

// The refresh token travels in the form body, so it is returned as a secret for the shared client to redact.
function createTokenRequestAuthorizer({ clientId, clientSecret, refreshToken }) {
  return ({ headers }) => {
    if (clientSecret) headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    return [refreshToken, clientSecret];
  };
}

/**
 * Maps OAuth token-endpoint errors (`{error, error_description}`): a 400/401
 * there means the refresh token or client credentials were rejected.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed response body (object)
 * @returns `{message, kind}` or `{}` (object)
 */
export function parseTokenError(status, body) {
  if (typeof body?.error !== "string") return {};
  const message = body.error_description ? `${body.error}: ${body.error_description}` : body.error;
  return { message, kind: status === 400 || status === 401 ? "auth_error" : undefined };
}
