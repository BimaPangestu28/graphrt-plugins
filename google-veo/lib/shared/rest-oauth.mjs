/**
 * OAuth2 access tokens for declarative REST plugins (`auth: {type: "oauth2", ...}`).
 *
 * Grants: `client_credentials` and `refresh_token`. Tokens are cached in memory per (token URL, client, refresh
 * token) until a minute before they expire; concurrent calls share one token request; a 401 from the API forces
 * one refresh (through the shared client's refreshCredentials). The client secret, refresh token and access
 * tokens are returned as secrets, so they are redacted from every error and response.
 */
import { createHash } from "node:crypto";
import { PluginError } from "./graphrt-plugin.mjs";

const TOKEN_TIMEOUT_MS = 30000;
const EXPIRY_MARGIN_MS = 60000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const cachedTokens = new Map();
const pendingTokenRequests = new Map();

/**
 * Empties the token cache (for tests).
 *
 * @returns Nothing
 */
export function clearOAuthTokenCache() {
  cachedTokens.clear();
  pendingTokenRequests.clear();
}

/**
 * Lists the env vars an oauth2 auth spec needs.
 *
 * @param auth - oauth2 auth spec (object)
 * @returns Env names: client id, client secret and, for refresh_token, the refresh token (string[])
 */
export function listOAuthEnv(auth) {
  return [auth.clientIdEnv, auth.clientSecretEnv, ...(auth.grant === "refresh_token" ? [auth.refreshTokenEnv] : [])];
}

/**
 * Creates a token source for one plugin run.
 *
 * @param auth - oauth2 auth spec (object)
 * @param environment - Environment variables (object)
 * @param fetchImpl - fetch implementation (function)
 * @returns `{getAccessToken, refresh, listSecrets}` (object)
 */
export function createOAuthTokenSource(auth, environment, fetchImpl) {
  const credentials = readOAuthCredentials(auth, environment);
  const cacheKey = buildCacheKey(auth, credentials);
  const requestToken = () => requestTokenOnce(cacheKey, () => fetchToken(auth, credentials, fetchImpl, cacheKey));
  return {
    getAccessToken: async () => {
      const cached = cachedTokens.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.accessToken;
      return (await requestToken()).accessToken;
    },
    refresh: async () => {
      cachedTokens.delete(cacheKey);
      await requestToken();
      return true;
    },
    listSecrets: () => [credentials.clientSecret, credentials.refreshToken, cachedTokens.get(cacheKey)?.accessToken, cachedTokens.get(cacheKey)?.refreshToken].filter(Boolean),
  };
}

function readOAuthCredentials(auth, environment) {
  const readEnv = (envName) => environment?.[envName]?.trim();
  return { clientId: readEnv(auth.clientIdEnv), clientSecret: readEnv(auth.clientSecretEnv), refreshToken: auth.grant === "refresh_token" ? readEnv(auth.refreshTokenEnv) : undefined };
}

function buildCacheKey(auth, credentials) {
  const secretHash = createHash("sha256").update(`${credentials.clientSecret}\n${credentials.refreshToken ?? ""}`).digest("hex");
  return `${auth.tokenUrl}\n${credentials.clientId}\n${auth.scope ?? ""}\n${secretHash}`;
}

async function requestTokenOnce(cacheKey, fetchNewToken) {
  if (!pendingTokenRequests.has(cacheKey)) {
    pendingTokenRequests.set(cacheKey, fetchNewToken().finally(() => pendingTokenRequests.delete(cacheKey)));
  }
  return pendingTokenRequests.get(cacheKey);
}

async function fetchToken(auth, credentials, fetchImpl, cacheKey) {
  const refreshToken = cachedTokens.get(cacheKey)?.refreshToken ?? credentials.refreshToken;
  const { headers, body } = buildTokenRequest(auth, { ...credentials, refreshToken });
  const secrets = [credentials.clientSecret, refreshToken].filter(Boolean);
  let tokenResponse;
  let tokenBody;
  try {
    tokenResponse = await fetchImpl(auth.tokenUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
    tokenBody = await tokenResponse.json().catch(() => ({}));
  } catch (transportError) {
    throw new PluginError(redact(`OAuth token request failed: ${transportError?.cause?.message ?? transportError?.message}`, secrets), { kind: "network_error", retryable: true });
  }
  if (!tokenResponse.ok || typeof tokenBody.access_token !== "string") throw describeTokenFailure(tokenResponse.status, tokenBody, secrets);
  const expiresInMs = (Number(tokenBody.expires_in) || DEFAULT_EXPIRES_IN_SECONDS) * 1000;
  const token = { accessToken: tokenBody.access_token, refreshToken: tokenBody.refresh_token ?? refreshToken, expiresAt: Date.now() + Math.max(0, expiresInMs - EXPIRY_MARGIN_MS) };
  cachedTokens.set(cacheKey, token);
  return token;
}

function buildTokenRequest(auth, credentials) {
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const formFields = { grant_type: auth.grant };
  if (auth.grant === "refresh_token") formFields.refresh_token = credentials.refreshToken;
  if (auth.clientAuth === "basic") {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(credentials.clientId)}:${encodeURIComponent(credentials.clientSecret)}`).toString("base64")}`;
  } else {
    Object.assign(formFields, { client_id: credentials.clientId, client_secret: credentials.clientSecret });
  }
  if (auth.scope) formFields.scope = auth.scope;
  if (auth.audience) formFields.audience = auth.audience;
  return { headers, body: new URLSearchParams(formFields).toString() };
}

function describeTokenFailure(status, tokenBody, secrets) {
  const reason = [tokenBody.error, tokenBody.error_description].filter((part) => typeof part === "string").join(": ") || "no access_token in the response";
  const kind = status >= 500 ? "api_error" : "auth_error";
  return new PluginError(redact(`OAuth token request failed (HTTP ${status}): ${reason}`, secrets), { kind, retryable: status >= 500 });
}

function redact(text, secrets) {
  return secrets.reduce((redactedText, secretValue) => redactedText.split(secretValue).join("[redacted]"), text);
}
