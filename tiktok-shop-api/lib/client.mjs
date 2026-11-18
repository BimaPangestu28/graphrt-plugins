/**
 * Signed TikTok Shop Partner API clients.
 *
 * Every request carries `app_key`, `timestamp` and `sign` in the query (plus `shop_cipher` for shop APIs) and the
 * access token in the `x-tts-access-token` header. The signature covers the path, every query parameter and the
 * exact body, so each request builds its own shared API client: `authorize` turns query values into the exact
 * strings that are sent, then signs them with the JSON body string that is sent. The app secret and access token
 * are returned from `authorize`, so the shared client redacts them from errors and `redactResponse` bodies.
 *
 * TikTok Shop reports failures as `{code, message, request_id}` with `code != 0`, also on HTTP 200. A 2xx body
 * without `code` (or not JSON) is an api_error, since success cannot be confirmed.
 * Operations receive `client = {shop, auth}`:
 * - `shop.request(options)` takes the shared client options (including `idempotent: true` for POST-only reads)
 *   plus `includeShopCipher` (default true) and `secrets`;
 * - `auth.refreshToken(refreshToken, signal)` calls auth.tiktok-shops.com (not signed, app secret in the query).
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { signTiktokShopRequest } from "./signing.mjs";

export const OPEN_API_BASE_URL = "https://open-api.tiktokglobalshop.com";
export const AUTH_BASE_URL = "https://auth.tiktok-shops.com";
// No "%" or ".": the signed path must be exactly the path the server sees, with no encodings or dot segments.
const API_PATH_PATTERN = /^\/[A-Za-z0-9_\-~]+(\/[A-Za-z0-9_\-~]+)*$/;
const UNKNOWN_OUTCOME_NOTE = " (outcome unknown: the write may have been applied; check before retrying)";
const CODE_KINDS = {
  36009002: "rate_limited",
  105002: "auth_error",
  106001: "auth_error",
  101000: "auth_error",
  36004004: "auth_error",
  105005: "permission_denied",
  36009033: "permission_denied",
  45102007: "permission_denied",
  106013: "invalid_input",
  36009009: "invalid_input",
  36009010: "invalid_input",
  36009014: "invalid_input",
  36009021: "invalid_input",
  36009022: "invalid_input",
  36009023: "invalid_input",
  45101002: "invalid_input",
  45101003: "not_found",
  45101004: "rate_limited",
  12052032: "not_found",
  12052260: "not_found",
};
// Daily quotas reset the next day, far beyond any retry window.
const NOT_RETRYABLE_CODES = new Set([45101004]);
// 36009004 is reused for credential, timestamp and identifier problems; the message tells them apart.
const CREDENTIAL_MESSAGE_PATTERN = /credential|signature|app_key|access_token|access-token|timestamp|token/i;

/**
 * Creates the signed Open API client and the token client for one run.
 *
 * @param options - `{accessToken, environment, fetchImpl}`; accessToken may be null (object)
 * @returns `{shop, auth}` (object)
 */
export function createTiktokShopClients({ accessToken, environment, fetchImpl }) {
  return { shop: createSignedClient(accessToken, environment, fetchImpl), auth: createAuthClient(environment, fetchImpl) };
}

/**
 * Picks the access token: node override, then TIKTOK_SHOP_ACCESS_TOKEN, else null. Returning null lets
 * `refresh_access_token` run without one; signed operations then fail with auth_error.
 *
 * @param options - `{environment, nodeToken}` (object)
 * @returns Token or null (string | null)
 */
export function resolveTiktokShopAccessToken({ environment, nodeToken }) {
  return nodeToken || environment?.TIKTOK_SHOP_ACCESS_TOKEN || null;
}

function createSignedClient(accessToken, environment, fetchImpl) {
  const request = async ({ includeShopCipher = true, secrets = [], json, headers, ...requestOptions }) => {
    validateApiPath(requestOptions.path);
    const credentials = readSigningCredentials(accessToken, environment, includeShopCipher);
    const bodyString = json === undefined ? undefined : JSON.stringify(json);
    const apiClient = createApiClient({
      baseUrl: OPEN_API_BASE_URL,
      authorize: (prepared) => signPreparedRequest(prepared, { ...credentials, path: requestOptions.path, bodyString, extraSecrets: secrets }),
      parseError: parseTiktokShopError,
      detectBodyError: (body) => detectTiktokShopBodyError(body, { isRead: isReadRequest(requestOptions) }),
      fetchImpl,
    });
    // The body is passed as the exact string that was signed, never re-serialized.
    return apiClient.request({ ...requestOptions, body: bodyString, headers: { ...headers, "content-type": "application/json" } });
  };
  return { request };
}

function signPreparedRequest({ headers, query }, { appKey, appSecret, accessToken, shopCipher, path, bodyString, extraSecrets }) {
  normalizeQueryInPlace(query);
  delete query.sign;
  delete query.access_token;
  Object.assign(query, { app_key: appKey, timestamp: String(Math.floor(Date.now() / 1000)) });
  if (shopCipher && query.shop_cipher === undefined) query.shop_cipher = shopCipher;
  query.sign = signTiktokShopRequest({ appSecret, path, query, body: bodyString });
  headers["x-tts-access-token"] = accessToken;
  return [appSecret, accessToken, ...extraSecrets].filter(Boolean);
}

/**
 * Converts query values to the exact strings the shared client sends (lists joined by commas, objects as JSON),
 * dropping empty ones, so the signature covers what goes on the wire.
 *
 * @param query - Query object, changed in place (object)
 */
export function normalizeQueryInPlace(query) {
  for (const [queryName, queryValue] of Object.entries(query)) {
    if (queryValue === undefined || queryValue === null) {
      delete query[queryName];
      continue;
    }
    const isPrimitiveList = Array.isArray(queryValue) && queryValue.every((item) => typeof item !== "object" || item === null);
    if (isPrimitiveList) query[queryName] = queryValue.join(",");
    else query[queryName] = typeof queryValue === "object" ? JSON.stringify(queryValue) : String(queryValue);
  }
}

function readSigningCredentials(accessToken, environment, includeShopCipher) {
  const { appKey, appSecret } = readAppCredentials(environment);
  if (!accessToken) throw missingCredential("TIKTOK_SHOP_ACCESS_TOKEN");
  if (!includeShopCipher) return { appKey, appSecret, accessToken };
  const shopCipher = environment?.TIKTOK_SHOP_CIPHER;
  if (!shopCipher) {
    rejectInput("Set TIKTOK_SHOP_CIPHER to the shop's `cipher` from get_authorized_shops (shop operations need it)");
  }
  return { appKey, appSecret, accessToken, shopCipher };
}

function readAppCredentials(environment) {
  const appKey = environment?.TIKTOK_SHOP_APP_KEY;
  const appSecret = environment?.TIKTOK_SHOP_APP_SECRET;
  if (!appKey) throw missingCredential("TIKTOK_SHOP_APP_KEY");
  if (!appSecret) throw missingCredential("TIKTOK_SHOP_APP_SECRET");
  return { appKey, appSecret };
}

function isReadRequest({ method, idempotent }) {
  return idempotent === true || (method ?? "GET").toUpperCase() === "GET";
}

// The token endpoint is not signed: the app secret and refresh token go in the query, and both are redacted.
// No retries: a refresh may rotate the refresh token, so it is treated as a write although it is a GET, and a
// network or server failure is reported as not retryable with an unknown outcome.
function createAuthClient(environment, fetchImpl) {
  const refreshToken = async (refreshTokenValue, signal) => {
    const { appKey, appSecret } = readAppCredentials(environment);
    const apiClient = createApiClient({
      baseUrl: AUTH_BASE_URL,
      authorize: ({ query }) => {
        Object.assign(query, { app_key: appKey, app_secret: appSecret, refresh_token: refreshTokenValue, grant_type: "refresh_token" });
        return [appSecret, refreshTokenValue];
      },
      parseError: parseTiktokShopError,
      detectBodyError: (body) => detectTiktokShopBodyError(body, { isRead: false }),
      maxRetries: 0,
      fetchImpl,
    });
    try {
      return await apiClient.request({ path: "/api/v2/token/refresh", signal });
    } catch (error) {
      throw markOutcomeUnknown(error);
    }
  };
  return { refreshToken };
}

/**
 * Makes a transport or server failure of a non-repeatable call not retryable, with the unknown-outcome note.
 *
 * @param error - Error thrown by the shared client (Error)
 * @returns The error to throw (Error)
 */
function markOutcomeUnknown(error) {
  const isUncertainFailure = error instanceof PluginError && (error.kind === "network_error" || error.kind === "api_error");
  if (!isUncertainFailure) return error;
  const message = error.message.includes(UNKNOWN_OUTCOME_NOTE) ? error.message : `${error.message}${UNKNOWN_OUTCOME_NOTE}`;
  return new PluginError(message, { kind: error.kind, retryable: false });
}

function missingCredential(variableName) {
  return new PluginError(`No TikTok Shop credential: set the ${variableName} environment variable (and allow it in permissions.env)`, {
    kind: "auth_error",
  });
}

function validateApiPath(path) {
  if (typeof path !== "string" || !API_PATH_PATTERN.test(path)) {
    rejectInput(`TikTok Shop API path must look like "/<module>/<version>/<resource>" without a query string, got ${JSON.stringify(path)}`);
  }
}

/**
 * Detects a TikTok Shop error envelope (`code` other than 0), on any HTTP status.
 *
 * @param body - Parsed response body (object)
 * @returns `{message, kind, retryable?}` or null when the call succeeded (object | null)
 *
 * @example
 * detectTiktokShopError({ code: 105002, message: "Expired credentials" }).kind; // "auth_error"
 */
export function detectTiktokShopError(body) {
  if (body?.code === undefined || body.code === null || body.code === "") return null;
  const code = Number(body.code);
  if (code === 0) return null;
  const details = [`code ${body.code}`, body.request_id && `request_id ${body.request_id}`].filter(Boolean).join(", ");
  const detected = { message: `${body.message || "TikTok Shop API error"} (${details})`, kind: kindForTiktokShopCode(code, body.message) };
  return NOT_RETRYABLE_CODES.has(code) ? { ...detected, retryable: false } : detected;
}

/**
 * Checks a 2xx TikTok Shop body: a missing `code` (or a non-JSON body) and `code != 0` become errors. On writes, a
 * missing envelope carries the unknown-outcome note.
 *
 * @param body - Parsed response body; non-JSON arrives as `{text}` (object)
 * @param requestContext - `{isRead}`: true for GET and idempotent (POST-only read) requests (object)
 * @returns `{message, kind, retryable?}` or null when the call succeeded (object | null)
 *
 * @example
 * detectTiktokShopBodyError({ data: {} }, { isRead: false }).message; // "... (outcome unknown: ...)"
 */
export function detectTiktokShopBodyError(body, { isRead }) {
  const hasEnvelope = body !== null && typeof body === "object" && body.code !== undefined && body.code !== null && body.code !== "";
  if (hasEnvelope) return detectTiktokShopError(body);
  const outcomeNote = isRead ? "" : UNKNOWN_OUTCOME_NOTE;
  return { message: `response without the TikTok Shop envelope (no \`code\`)${outcomeNote}`, kind: "api_error", retryable: false };
}

/**
 * Maps a non-2xx response; bodies without a TikTok Shop envelope fall back to the HTTP status mapping.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed response body (object)
 * @returns `{message, kind?, retryable?}` or `{}` (object)
 */
export function parseTiktokShopError(status, body) {
  const detected = detectTiktokShopError(body);
  if (!detected) return {};
  // api_error is left to the status mapping, so 5xx on reads stays retryable and 429 stays rate_limited.
  return detected.kind === "api_error" ? { message: detected.message } : detected;
}

function kindForTiktokShopCode(code, message) {
  if (CODE_KINDS[code]) return CODE_KINDS[code];
  if (code === 36009004) return CREDENTIAL_MESSAGE_PATTERN.test(String(message ?? "")) ? "auth_error" : "invalid_input";
  if (code >= 105000 && code < 106000) return "auth_error";
  return "api_error";
}

/**
 * Converts a `{<list>, next_page_token}` payload into the operation output shape.
 *
 * @param payload - The `data` object of a list response (object)
 * @param listKey - Property holding the items, e.g. "orders" (string)
 * @param incomingCursor - The cursor this page was requested with (string | undefined)
 * @returns `{data, next_cursor}`; next_cursor is null when the token is empty or repeats the incoming cursor,
 *   so a paging loop cannot spin on the same page (object)
 */
export function toPageTokenPage(payload, listKey, incomingCursor) {
  const nextPageToken = payload?.next_page_token ? String(payload.next_page_token) : null;
  return { data: payload?.[listKey] ?? [], next_cursor: nextPageToken === incomingCursor ? null : nextPageToken };
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
