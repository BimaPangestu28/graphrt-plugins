/**
 * Google credentials for one run: a ready access token, the OAuth refresh trio,
 * or a service account key file.
 *
 * Precedence: a node's `access_token` (used as-is, never refreshed) >
 * GOOGLE_ACCESS_TOKEN (used first; a configured grant takes over after a 401) >
 * the refresh trio GOOGLE_REFRESH_TOKEN + GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET >
 * GOOGLE_SERVICE_ACCOUNT_JSON (path to a key file).
 *
 * Tokens fetched with a grant are cached in module scope (the plugin process
 * is long-lived) until 60 s before they expire. Concurrent callers share one
 * in-flight fetch. Approach copied from youtube-api/lib/oauth.mjs, plus the
 * service account grant; plugins never import each other.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { requestGoogleAccessToken } from "./google-token-endpoint.mjs";
import { fetchAccessTokenWithServiceAccount } from "./service-account.mjs";

export const GOOGLE_AUTH_ENV = ["GOOGLE_REFRESH_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_SERVICE_ACCOUNT_JSON"];
const REFRESH_TRIO_NAMES = ["GOOGLE_REFRESH_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
const EXPIRY_SAFETY_MARGIN_MS = 60000;

// Keyed per grant; values `{accessToken, expiresAtMs}` or `{pending: Promise}`.
const cachedAccessTokens = new Map();

/**
 * Picks the credentials for one run. Used as the plugin's `resolveAccessToken` hook.
 *
 * @param options - `{environment, nodeToken}` (object)
 * @returns `{staticToken?, grant?}` where grant is `{type: "refresh_token" | "service_account", ...}` (object)
 * @throws PluginError kind `auth_error` - When no usable credential is configured
 */
export function resolveGoogleCredentials({ environment, nodeToken }) {
  if (nodeToken) return { staticToken: nodeToken };
  const staticToken = readVariable(environment, "GOOGLE_ACCESS_TOKEN");
  const grant = readRefreshGrant(environment) ?? readServiceAccountGrant(environment);
  if (staticToken || grant) return { staticToken, grant };
  throw new PluginError(describeMissingCredentials(environment), { kind: "auth_error" });
}

function readVariable(environment, variableName) {
  return environment?.[variableName]?.trim() || undefined;
}

function readRefreshGrant(environment) {
  const [refreshToken, clientId, clientSecret] = REFRESH_TRIO_NAMES.map((variableName) => readVariable(environment, variableName));
  return refreshToken && clientId && clientSecret ? { type: "refresh_token", refreshToken, clientId, clientSecret } : undefined;
}

function readServiceAccountGrant(environment) {
  const keyFilePath = readVariable(environment, "GOOGLE_SERVICE_ACCOUNT_JSON");
  return keyFilePath ? { type: "service_account", keyFilePath } : undefined;
}

function describeMissingCredentials(environment) {
  const missingNames = REFRESH_TRIO_NAMES.filter((variableName) => !readVariable(environment, variableName));
  const isPartialTrio = missingNames.length < REFRESH_TRIO_NAMES.length;
  const partialHint = isPartialTrio ? ` (refresh setup is incomplete: missing ${missingNames.join(", ")})` : "";
  return (
    "No Google credentials: set GOOGLE_REFRESH_TOKEN + GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET, or GOOGLE_SERVICE_ACCOUNT_JSON " +
    "(path to a service account key file), or GOOGLE_ACCESS_TOKEN (and allow them in permissions.env), " +
    `or pass \`access_token\` on the node${partialHint}`
  );
}

/**
 * Creates the per-run token source behind the client's `authorize` and `refreshCredentials` hooks.
 *
 * @param credentials - Result of resolveGoogleCredentials (object)
 * @param options - `{scope, fetchImpl, readFileImpl}`; scope is space-separated (object)
 * @returns `{getAccessToken: () => Promise<string>, refreshAccessToken: () => Promise<boolean>}`
 */
export function createAccessTokenSource(credentials, { scope, fetchImpl, readFileImpl } = {}) {
  let isUsingStaticToken = Boolean(credentials.staticToken);
  const fetchFreshToken = () => fetchTokenForGrant(credentials.grant, { scope, fetchImpl, readFileImpl });
  const getAccessToken = async () =>
    isUsingStaticToken ? credentials.staticToken : readCachedOrFetchToken(buildCacheKey(credentials.grant, scope), fetchFreshToken, false);
  const refreshAccessToken = async () => {
    if (!credentials.grant) return false;
    await readCachedOrFetchToken(buildCacheKey(credentials.grant, scope), fetchFreshToken, true);
    isUsingStaticToken = false;
    return true;
  };
  return { getAccessToken, refreshAccessToken };
}

function buildCacheKey(grant, scope) {
  const grantIdentity = grant.type === "refresh_token" ? `${grant.clientId}\u0000${grant.refreshToken}` : grant.keyFilePath;
  return `${grant.type}\u0000${scope}\u0000${grantIdentity}`;
}

function fetchTokenForGrant(grant, { scope, fetchImpl, readFileImpl }) {
  if (grant.type === "service_account") return fetchAccessTokenWithServiceAccount({ keyFilePath: grant.keyFilePath, scope }, { fetchImpl, readFileImpl });
  return fetchAccessTokenWithRefreshToken(grant, fetchImpl);
}

async function readCachedOrFetchToken(cacheKey, fetchFreshToken, isForcedRefresh) {
  const cachedEntry = cachedAccessTokens.get(cacheKey);
  if (cachedEntry?.pending) return (await cachedEntry.pending).accessToken;
  if (!isForcedRefresh && cachedEntry && cachedEntry.expiresAtMs - EXPIRY_SAFETY_MARGIN_MS > Date.now()) return cachedEntry.accessToken;
  const pending = fetchFreshToken();
  cachedAccessTokens.set(cacheKey, { pending });
  try {
    const freshEntry = await pending;
    cachedAccessTokens.set(cacheKey, freshEntry);
    return freshEntry.accessToken;
  } catch (fetchError) {
    cachedAccessTokens.delete(cacheKey);
    throw fetchError;
  }
}

/**
 * Exchanges a refresh token for an access token at Google's token endpoint.
 *
 * @param refreshGrant - `{refreshToken, clientId, clientSecret}` (object)
 * @param fetchImpl - fetch implementation (function, optional)
 * @returns `{accessToken, expiresAtMs}` (Promise<object>)
 * @throws PluginError kinds `auth_error` (rejected grant/client), `rate_limited`, `api_error`, `network_error`
 */
export function fetchAccessTokenWithRefreshToken(refreshGrant, fetchImpl) {
  const form = {
    grant_type: "refresh_token",
    refresh_token: refreshGrant.refreshToken,
    client_id: refreshGrant.clientId,
    client_secret: refreshGrant.clientSecret,
  };
  return requestGoogleAccessToken({ form, secrets: [refreshGrant.refreshToken, refreshGrant.clientSecret], flowName: "token refresh" }, fetchImpl);
}

/**
 * Empties the module-level access-token cache (for tests).
 */
export function clearCachedAccessTokens() {
  cachedAccessTokens.clear();
}
