/**
 * Google OAuth access-token handling for youtube-api.
 *
 * A run authenticates with either a ready access token (YOUTUBE_ACCESS_TOKEN or
 * a node's `access_token`) or the refresh trio YOUTUBE_REFRESH_TOKEN +
 * YOUTUBE_CLIENT_ID + YOUTUBE_CLIENT_SECRET. With the trio, access tokens are
 * fetched lazily from Google's token endpoint and cached in module scope (the
 * plugin process is long-lived) until 60 s before they expire.
 *
 * The token endpoint is a different origin from the YouTube API, so it is
 * called with its own fetch, never through the YouTube client. Secrets are
 * redacted from every error message.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_TRIO_NAMES = ["YOUTUBE_REFRESH_TOKEN", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"];
const EXPIRY_SAFETY_MARGIN_MS = 60000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const TOKEN_REQUEST_TIMEOUT_MS = 30000;
const TOKEN_ERROR_KINDS = { 400: "auth_error", 401: "auth_error", 403: "permission_denied", 429: "rate_limited" };

// Keyed by client id + refresh token; values `{accessToken, expiresAtMs}` or `{pending: Promise}`.
const cachedAccessTokens = new Map();

/**
 * Picks the credentials for one run. Used as the plugin's `resolveAccessToken` hook.
 *
 * @param options - `{environment, nodeToken}` (object)
 * @returns `{staticToken?, refreshGrant?}`; a node token never gets a refresh grant (object)
 * @throws PluginError kind `auth_error` - When neither an access token nor the full refresh trio is set
 */
export function resolveYouTubeCredentials({ environment, nodeToken }) {
  if (nodeToken) return { staticToken: nodeToken };
  const staticToken = environment?.YOUTUBE_ACCESS_TOKEN?.trim() || undefined;
  const refreshGrant = readRefreshGrant(environment);
  if (staticToken || refreshGrant) return { staticToken, refreshGrant };
  throw new PluginError(describeMissingCredentials(environment), { kind: "auth_error" });
}

function readRefreshGrant(environment) {
  const [refreshToken, clientId, clientSecret] = REFRESH_TRIO_NAMES.map((variableName) => environment?.[variableName]?.trim());
  return refreshToken && clientId && clientSecret ? { refreshToken, clientId, clientSecret } : undefined;
}

function describeMissingCredentials(environment) {
  const missingNames = REFRESH_TRIO_NAMES.filter((variableName) => !environment?.[variableName]?.trim());
  const isPartialTrio = missingNames.length < REFRESH_TRIO_NAMES.length;
  const partialHint = isPartialTrio ? ` (refresh setup is incomplete: missing ${missingNames.join(", ")})` : "";
  return (
    "No YouTube credentials: set YOUTUBE_ACCESS_TOKEN, or set YOUTUBE_REFRESH_TOKEN + YOUTUBE_CLIENT_ID + YOUTUBE_CLIENT_SECRET " +
    `(and allow them in permissions.env), or pass \`access_token\` on the node${partialHint}`
  );
}

/**
 * Creates the per-run token source behind the client's `authorize` and `refreshCredentials` hooks.
 *
 * @param credentials - Result of resolveYouTubeCredentials (object)
 * @param fetchImpl - fetch implementation for the token endpoint (function, optional)
 * @returns `{getAccessToken: () => Promise<string>, refreshAccessToken: () => Promise<boolean>}`
 */
export function createAccessTokenSource(credentials, fetchImpl) {
  let isUsingStaticToken = Boolean(credentials.staticToken);
  const getAccessToken = async () =>
    isUsingStaticToken ? credentials.staticToken : readCachedOrFetchToken(credentials.refreshGrant, fetchImpl, false);
  const refreshAccessToken = async () => {
    if (!credentials.refreshGrant) return false;
    await readCachedOrFetchToken(credentials.refreshGrant, fetchImpl, true);
    isUsingStaticToken = false;
    return true;
  };
  return { getAccessToken, refreshAccessToken };
}

async function readCachedOrFetchToken(refreshGrant, fetchImpl, isForcedRefresh) {
  const cacheKey = `${refreshGrant.clientId}\u0000${refreshGrant.refreshToken}`;
  const cachedEntry = cachedAccessTokens.get(cacheKey);
  if (cachedEntry?.pending) return (await cachedEntry.pending).accessToken;
  if (!isForcedRefresh && cachedEntry && cachedEntry.expiresAtMs - EXPIRY_SAFETY_MARGIN_MS > Date.now()) return cachedEntry.accessToken;
  const pending = fetchAccessTokenWithRefreshToken(refreshGrant, fetchImpl);
  cachedAccessTokens.set(cacheKey, { pending });
  try {
    const freshEntry = await pending;
    cachedAccessTokens.set(cacheKey, freshEntry);
    return freshEntry.accessToken;
  } catch (refreshError) {
    cachedAccessTokens.delete(cacheKey);
    throw refreshError;
  }
}

/**
 * Exchanges a refresh token for an access token at Google's token endpoint.
 *
 * @param refreshGrant - `{refreshToken, clientId, clientSecret}` (object)
 * @param fetchImpl - fetch implementation (function, default global fetch)
 * @returns `{accessToken, expiresAtMs}` (Promise<object>)
 * @throws PluginError kinds `auth_error` (rejected grant/client), `rate_limited`, `api_error`, `network_error`
 */
export async function fetchAccessTokenWithRefreshToken(refreshGrant, fetchImpl = (...fetchArguments) => globalThis.fetch(...fetchArguments)) {
  const secrets = [refreshGrant.refreshToken, refreshGrant.clientSecret];
  let tokenResponse;
  try {
    tokenResponse = await fetchImpl(GOOGLE_TOKEN_URL, buildTokenRequest(refreshGrant));
  } catch (fetchError) {
    const reason = String(fetchError?.cause?.message ?? fetchError?.message ?? fetchError);
    throw new PluginError(redactSecrets(`Google token refresh failed: network error: ${reason}`, secrets), { kind: "network_error", retryable: true });
  }
  const responseBody = await readJsonBody(tokenResponse);
  if (!tokenResponse.ok) throw buildTokenEndpointError(tokenResponse.status, responseBody, secrets);
  if (typeof responseBody.access_token !== "string" || responseBody.access_token === "") {
    throw new PluginError("Google token refresh failed: the response has no access_token", { kind: "api_error" });
  }
  const expiresInSeconds = Number(responseBody.expires_in) || DEFAULT_EXPIRES_IN_SECONDS;
  return { accessToken: responseBody.access_token, expiresAtMs: Date.now() + expiresInSeconds * 1000 };
}

function buildTokenRequest(refreshGrant) {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshGrant.refreshToken,
    client_id: refreshGrant.clientId,
    client_secret: refreshGrant.clientSecret,
  });
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
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

function buildTokenEndpointError(status, responseBody, secrets) {
  const errorCode = typeof responseBody.error === "string" ? responseBody.error : responseBody.error?.status;
  const description = responseBody.error_description ?? responseBody.error?.message ?? responseBody.text ?? "";
  const detail = [errorCode, description].filter(Boolean).join(": ");
  const kind = TOKEN_ERROR_KINDS[status] ?? "api_error";
  const message = redactSecrets(`Google token refresh failed (HTTP ${status}): ${detail || "no details"}`, secrets);
  return new PluginError(message, { kind, retryable: kind === "rate_limited" || status >= 500 });
}

function redactSecrets(text, secrets) {
  return secrets.filter((secretValue) => secretValue && secretValue.length >= 4).reduce((redactedText, secretValue) => redactedText.split(secretValue).join("[redacted]"), text);
}

/**
 * Empties the module-level access-token cache (for tests).
 */
export function clearCachedAccessTokens() {
  cachedAccessTokens.clear();
}
