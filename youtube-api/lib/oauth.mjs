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
// Env access tokens that got a 401 and were replaced by the refresh trio; later runs skip them.
const replacedStaticTokens = new Set();

/**
 * Picks the credentials for one run. Used as the plugin's `resolveAccessToken` hook.
 *
 * @param options - `{environment, nodeToken}` (object)
 * @returns `{staticToken?, refreshGrant?, partialRefreshHint?}`; a node token never gets a refresh grant.
 *   `partialRefreshHint` names the missing trio variables when YOUTUBE_ACCESS_TOKEN is set next to an incomplete trio (object)
 * @throws PluginError kind `auth_error` - When neither an access token nor the full refresh trio is set
 */
export function resolveYouTubeCredentials({ environment, nodeToken }) {
  if (nodeToken) return { staticToken: nodeToken };
  const staticToken = environment?.YOUTUBE_ACCESS_TOKEN?.trim() || undefined;
  const refreshGrant = readRefreshGrant(environment);
  if (staticToken || refreshGrant) return { staticToken, refreshGrant, partialRefreshHint: describePartialTrio(environment) };
  throw new PluginError(describeMissingCredentials(environment), { kind: "auth_error" });
}

function readRefreshGrant(environment) {
  const [refreshToken, clientId, clientSecret] = REFRESH_TRIO_NAMES.map((variableName) => environment?.[variableName]?.trim());
  return refreshToken && clientId && clientSecret ? { refreshToken, clientId, clientSecret } : undefined;
}

// Names only the missing variables (never values); undefined when the trio is complete or entirely unset.
function describePartialTrio(environment) {
  const missingNames = REFRESH_TRIO_NAMES.filter((variableName) => !environment?.[variableName]?.trim());
  const isPartialTrio = missingNames.length > 0 && missingNames.length < REFRESH_TRIO_NAMES.length;
  return isPartialTrio ? `refresh setup is incomplete: missing ${missingNames.join(", ")}` : undefined;
}

function describeMissingCredentials(environment) {
  const partialHint = describePartialTrio(environment);
  return (
    "No YouTube credentials: set YOUTUBE_ACCESS_TOKEN, or set YOUTUBE_REFRESH_TOKEN + YOUTUBE_CLIENT_ID + YOUTUBE_CLIENT_SECRET " +
    `(and allow them in permissions.env), or pass \`access_token\` on the node${partialHint ? ` (${partialHint})` : ""}`
  );
}

/**
 * Creates the per-run token source behind the client's `authorize` and `refreshCredentials` hooks.
 *
 * @param credentials - Result of resolveYouTubeCredentials (object)
 * @param fetchImpl - fetch implementation for the token endpoint (function, optional)
 * @returns `{getAccessToken: (signal?) => Promise<string>, refreshAccessToken: (signal?) => Promise<boolean>}`;
 *   the optional AbortSignal cancels a token request this caller waits on
 */
export function createAccessTokenSource(credentials, fetchImpl) {
  const { staticToken, refreshGrant } = credentials;
  let isUsingStaticToken = Boolean(staticToken) && !(refreshGrant && replacedStaticTokens.has(staticToken));
  const getAccessToken = async (signal) => (isUsingStaticToken ? staticToken : readCachedOrFetchToken(refreshGrant, fetchImpl, { isForcedRefresh: false, signal }));
  const refreshAccessToken = async (signal) => {
    if (!refreshGrant) return false;
    await readCachedOrFetchToken(refreshGrant, fetchImpl, { isForcedRefresh: true, signal });
    if (isUsingStaticToken) replacedStaticTokens.add(staticToken);
    isUsingStaticToken = false;
    return true;
  };
  return { getAccessToken, refreshAccessToken };
}

async function readCachedOrFetchToken(refreshGrant, fetchImpl, { isForcedRefresh, signal }) {
  const cacheKey = `${refreshGrant.clientId}\u0000${refreshGrant.refreshToken}`;
  const cachedEntry = cachedAccessTokens.get(cacheKey);
  if (cachedEntry?.pending) {
    const sharedEntry = await waitForSharedRefresh(cachedEntry.pending, signal);
    if (sharedEntry) return sharedEntry.accessToken;
  } else if (!isForcedRefresh && cachedEntry && cachedEntry.expiresAtMs - EXPIRY_SAFETY_MARGIN_MS > Date.now()) {
    return cachedEntry.accessToken;
  }
  const pending = fetchAccessTokenWithRefreshToken(refreshGrant, fetchImpl, signal);
  cachedAccessTokens.set(cacheKey, { pending });
  try {
    const freshEntry = await pending;
    cachedAccessTokens.set(cacheKey, freshEntry);
    return freshEntry.accessToken;
  } catch (refreshError) {
    if (cachedAccessTokens.get(cacheKey)?.pending === pending) cachedAccessTokens.delete(cacheKey);
    throw refreshError;
  }
}

// Waits for another caller's token request, but stops when this caller is cancelled. Returns
// undefined when that request was cancelled by its own caller, so this caller fetches its own token.
async function waitForSharedRefresh(pending, signal) {
  try {
    return await raceWithCancellation(pending, signal);
  } catch (sharedError) {
    if (sharedError?.kind === "cancelled" && !signal?.aborted) return undefined;
    throw sharedError;
  }
}

function raceWithCancellation(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    const rejectOnAbort = () => reject(cancelledError());
    signal.addEventListener("abort", rejectOnAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", rejectOnAbort));
  });
}

function cancelledError() {
  return new PluginError("Google token refresh cancelled", { kind: "cancelled" });
}

/**
 * Exchanges a refresh token for an access token at Google's token endpoint.
 *
 * @param refreshGrant - `{refreshToken, clientId, clientSecret}` (object)
 * @param fetchImpl - fetch implementation (function, default global fetch)
 * @param signal - Caller's cancellation signal, combined with a 30 s timeout (AbortSignal, optional)
 * @returns `{accessToken, expiresAtMs}` (Promise<object>)
 * @throws PluginError kinds `auth_error` (rejected grant/client), `rate_limited`, `api_error`, `network_error`, `cancelled`
 */
export async function fetchAccessTokenWithRefreshToken(refreshGrant, fetchImpl = (...fetchArguments) => globalThis.fetch(...fetchArguments), signal) {
  const secrets = [refreshGrant.refreshToken, refreshGrant.clientSecret];
  let tokenResponse;
  let responseBody;
  try {
    tokenResponse = await fetchImpl(GOOGLE_TOKEN_URL, buildTokenRequest(refreshGrant, signal));
    responseBody = await readJsonBody(tokenResponse);
  } catch (fetchError) {
    if (signal?.aborted) throw cancelledError();
    const reason = String(fetchError?.cause?.message ?? fetchError?.message ?? fetchError);
    throw new PluginError(redactSecrets(`Google token refresh failed: network error: ${reason}`, secrets), { kind: "network_error", retryable: true });
  }
  if (!tokenResponse.ok) throw buildTokenEndpointError(tokenResponse.status, responseBody, secrets);
  if (typeof responseBody.access_token !== "string" || responseBody.access_token === "") {
    throw new PluginError("Google token refresh failed: the response has no access_token", { kind: "api_error" });
  }
  const expiresInSeconds = Number(responseBody.expires_in) || DEFAULT_EXPIRES_IN_SECONDS;
  return { accessToken: responseBody.access_token, expiresAtMs: Date.now() + expiresInSeconds * 1000 };
}

function buildTokenRequest(refreshGrant, signal) {
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
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
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
 * Empties the module-level access-token cache and the replaced-env-token memory (for tests).
 */
export function clearCachedAccessTokens() {
  cachedAccessTokens.clear();
  replacedStaticTokens.clear();
}
