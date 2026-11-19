/**
 * Zoom Server-to-Server OAuth (https://developers.zoom.us/docs/internal-apps/s2s-oauth/).
 *
 * Zoom's grant is `account_credentials` (POST https://zoom.us/oauth/token, form body
 * `grant_type=account_credentials&account_id=...`, Basic client_id:client_secret). The declarative layer's oauth2
 * auth only sends `grant_type=client_credentials` (a different Zoom grant, for chatbot tokens), so the plugin uses
 * custom auth and this module fetches the token.
 *
 * - Tokens last one hour and have no refresh token; they are cached in memory per (account, client, secret hash)
 *   until a minute before expiry, and concurrent calls share one token request.
 * - The custom `authorize` hook receives no fetch implementation, so the plugin's createClient registers one per
 *   run with `registerTokenFetch(environment, fetchImpl)` (a WeakMap keyed by that run's environment object).
 * - A node's `access_token` (any credential that is not ZOOM_CLIENT_SECRET) is sent as Bearer directly.
 * - The client secret and access token are returned as secrets, so they are redacted from errors and responses.
 *   Token endpoint failures are `auth_error` (5xx: retryable `api_error`; network: retryable `network_error`).
 */
import { createHash } from "node:crypto";
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";
export const ACCOUNT_ID_ENV = "ZOOM_ACCOUNT_ID";
export const CLIENT_ID_ENV = "ZOOM_CLIENT_ID";
export const CLIENT_SECRET_ENV = "ZOOM_CLIENT_SECRET";
const TOKEN_TIMEOUT_MS = 30000;
const EXPIRY_MARGIN_MS = 60000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const cachedTokens = new Map();
const pendingTokenRequests = new Map();
const tokenFetchByEnvironment = new WeakMap();
const runSignalByEnvironment = new WeakMap();

/**
 * Empties the token cache (for tests).
 *
 * @returns Nothing
 */
export function clearZoomTokenCache() {
  cachedTokens.clear();
  pendingTokenRequests.clear();
}

/**
 * Registers the fetch implementation the token request of one run uses.
 *
 * @param environment - The environment object passed to the run's client (object)
 * @param fetchImpl - fetch implementation (function, default global fetch)
 * @returns The same environment (object)
 */
export function registerTokenFetch(environment, fetchImpl) {
  tokenFetchByEnvironment.set(environment, fetchImpl ?? ((...fetchArguments) => globalThis.fetch(...fetchArguments)));
  return environment;
}

/**
 * Registers the run's abort signal, so a cancelled run also cancels the token request it started.
 *
 * @param environment - The environment object of the run's client (object)
 * @param signal - The run's signal (AbortSignal, optional)
 * @returns The same environment (object)
 */
export function registerRunSignal(environment, signal) {
  if (signal) runSignalByEnvironment.set(environment, signal);
  return environment;
}

/**
 * Puts a token into the cache, e.g. one fetched elsewhere, or a fake one in tests.
 *
 * @param environment - Environment with the ZOOM_* variables (object)
 * @param accessToken - Access token (string)
 * @param expiresInMs - Time until it must not be used any more (number, default one hour)
 * @returns Nothing
 */
export function primeZoomToken(environment, accessToken, expiresInMs = DEFAULT_EXPIRES_IN_SECONDS * 1000) {
  cachedTokens.set(buildCacheKey(readClientCredentials(environment)), { accessToken, expiresAt: Date.now() + expiresInMs });
}

/**
 * Drops the cached token of the environment's app, so the next call fetches a new one (after a 401).
 *
 * @param environment - Environment with the ZOOM_* variables (object)
 * @returns Nothing
 */
export function invalidateZoomToken(environment) {
  const credentials = readOptionalCredentials(environment);
  if (credentials) cachedTokens.delete(buildCacheKey(credentials));
}

/**
 * Custom auth hook for the declarative layer: sets `Authorization: Bearer <token>`.
 *
 * @param request - `{headers, credential, environment}` from the layer (object)
 * @returns Secrets to redact (Promise<string[]>)
 * @throws PluginError kind `auth_error` - Missing ZOOM_* variables, or the token endpoint refused the app
 * @throws PluginError kinds `api_error` / `network_error` (retryable) - Token endpoint 5xx or unreachable
 */
export async function authorizeZoomRequest({ headers, credential, environment }) {
  const clientSecret = environment?.[CLIENT_SECRET_ENV]?.trim();
  if (credential && credential !== clientSecret) {
    headers.authorization = `Bearer ${credential}`;
    return [credential];
  }
  const credentials = readClientCredentials(environment);
  const accessToken = await getAccessToken(credentials, tokenFetchByEnvironment.get(environment) ?? globalThis.fetch, runSignalByEnvironment.get(environment));
  headers.authorization = `Bearer ${accessToken}`;
  return [accessToken, credentials.clientSecret];
}

function readClientCredentials(environment) {
  const readRequired = (envName) => {
    const value = typeof environment?.[envName] === "string" ? environment[envName].trim() : "";
    if (!value) throw new PluginError(`No credential: set the ${envName} environment variable (and allow it in permissions.env)`, { kind: "auth_error" });
    return value;
  };
  return { accountId: readRequired(ACCOUNT_ID_ENV), clientId: readRequired(CLIENT_ID_ENV), clientSecret: readRequired(CLIENT_SECRET_ENV) };
}

function readOptionalCredentials(environment) {
  try {
    return readClientCredentials(environment);
  } catch (missingCredential) {
    if (missingCredential instanceof PluginError) return undefined;
    throw missingCredential;
  }
}

function buildCacheKey({ accountId, clientId, clientSecret }) {
  const secretHash = createHash("sha256").update(clientSecret).digest("hex");
  return `${accountId}\n${clientId}\n${secretHash}`;
}

// Concurrent calls share one token request. It carries the signal of the run that started it, so when that run is
// cancelled, the other waiting runs (not cancelled themselves) start their own request instead of failing.
async function getAccessToken(credentials, fetchImpl, runSignal) {
  const cacheKey = buildCacheKey(credentials);
  const cached = cachedTokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken;
  const shared = pendingTokenRequests.get(cacheKey);
  if (shared) {
    try {
      return (await shared.request).accessToken;
    } catch (sharedError) {
      const cancelledByAnotherRun = sharedError?.kind === "cancelled" && shared.runSignal !== runSignal && !runSignal?.aborted;
      if (!cancelledByAnotherRun) throw sharedError;
    }
  }
  return (await startTokenRequest(cacheKey, credentials, fetchImpl, runSignal)).accessToken;
}

function startTokenRequest(cacheKey, credentials, fetchImpl, runSignal) {
  const request = fetchToken(credentials, fetchImpl, runSignal).then((token) => (cachedTokens.set(cacheKey, token), token));
  const entry = { runSignal, request };
  pendingTokenRequests.set(cacheKey, entry);
  // The cleanup chain only removes the entry; the request's own rejection reaches every caller that awaits it.
  request.finally(() => pendingTokenRequests.get(cacheKey) === entry && pendingTokenRequests.delete(cacheKey)).catch(() => {});
  return request;
}

async function fetchToken(credentials, fetchImpl, runSignal) {
  const secrets = [credentials.clientSecret];
  const basicCredentials = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
  const init = {
    method: "POST",
    headers: { authorization: `Basic ${basicCredentials}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "account_credentials", account_id: credentials.accountId }).toString(),
    signal: runSignal ? AbortSignal.any([AbortSignal.timeout(TOKEN_TIMEOUT_MS), runSignal]) : AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  };
  let tokenResponse;
  let tokenBody;
  try {
    tokenResponse = await fetchImpl(ZOOM_TOKEN_URL, init);
    tokenBody = await tokenResponse.json().catch(() => ({}));
  } catch (transportError) {
    if (runSignal?.aborted) throw new PluginError("Cancelled while requesting a Zoom access token", { kind: "cancelled", retryable: false });
    throw new PluginError(redact(`Zoom token request failed: ${transportError?.cause?.message ?? transportError?.message}`, secrets), { kind: "network_error", retryable: true });
  }
  if (!tokenResponse.ok || typeof tokenBody?.access_token !== "string") throw describeTokenFailure(tokenResponse.status, tokenBody, secrets);
  const expiresInMs = (Number(tokenBody.expires_in) || DEFAULT_EXPIRES_IN_SECONDS) * 1000;
  return { accessToken: tokenBody.access_token, expiresAt: Date.now() + expiresInMs - EXPIRY_MARGIN_MS };
}

function describeTokenFailure(status, tokenBody, secrets) {
  const reasonParts = [tokenBody?.error, tokenBody?.reason ?? tokenBody?.error_description].filter((part) => typeof part === "string");
  const reason = reasonParts.join(": ") || "no access_token in the response";
  const isServerError = status >= 500;
  const message = `Zoom token request failed (HTTP ${status}): ${reason}. Check ${ACCOUNT_ID_ENV}, ${CLIENT_ID_ENV} and ${CLIENT_SECRET_ENV} of the Server-to-Server OAuth app`;
  return new PluginError(redact(message, secrets), { kind: isServerError ? "api_error" : "auth_error", retryable: isServerError });
}

function redact(text, secrets) {
  return secrets.filter(Boolean).reduce((redactedText, secretValue) => redactedText.split(secretValue).join("[redacted]"), text);
}
