/**
 * Signed Shopee Open Platform v2 clients.
 *
 * Every request carries `partner_id`, `timestamp` and `sign` in the query; shop APIs also carry `access_token` and
 * `shop_id`. The signature covers the request path, so each request builds its own shared API client whose
 * `authorize` hook signs that path with a fresh timestamp. The partner key and access token are returned from
 * `authorize`, so the shared client redacts them from errors and from `redactResponse` bodies.
 *
 * Shopee reports failures as `{error, message, request_id}` with a non-empty `error`, often on HTTP 200. A 2xx body
 * without that envelope (not JSON, or no `error` field) is treated as an api_error, since success cannot be confirmed.
 * Operations receive `client = {shop, public}`; both expose `request(options)` like the shared client, plus
 * `repeatedQuery` (`{name: [values]}` sent as name=a&name=b) and `secrets` (extra values to redact).
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { computeShopeeSignature } from "./signing.mjs";

export const SHOPEE_HOSTS = {
  live: "https://partner.shopeemobile.com",
  test: "https://openplatform.sandbox.test-stable.shopee.sg",
};
const API_PATH_PATTERN = /^\/api\/v2\/[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/;
const NUMERIC_ID_PATTERN = /^\d{1,19}$/;
const ERROR_KINDS = {
  error_auth: "auth_error",
  error_sign: "auth_error",
  invalid_access_token: "auth_error",
  invalid_acceess_token: "auth_error",
  invalid_partner_id: "auth_error",
  error_partner_key_expired: "auth_error",
  error_param: "invalid_input",
  error_permission: "permission_denied",
  error_api_permission: "permission_denied",
  error_api_call_restricted: "permission_denied",
  error_ashop_api_permission: "permission_denied",
  error_kyc_auth: "permission_denied",
  shop_no_linked: "permission_denied",
  partner_shop_no_link: "permission_denied",
  shop_banned: "permission_denied",
  source_ip_undeclared: "permission_denied",
  error_not_found: "not_found",
  error_item_not_found: "not_found",
  error_too_many_requests: "rate_limited",
  error_rate_limit: "rate_limited",
  rate_limit: "rate_limited",
  error_limit: "rate_limited",
};
// The daily quota resets at 00:00 UTC+8, far beyond any retry window.
const NOT_RETRYABLE_CODES = new Set(["error_limit"]);
// Transient server-side failures Shopee reports inside HTTP 200 bodies. Safe to retry on a GET only: on a POST the
// write may already have been applied.
const SERVER_FAILURE_CODES = new Set(["error_server", "error_inner", "error_busy", "error_network"]);
const UNKNOWN_OUTCOME_NOTE = " (outcome unknown: the write may have been applied; check before retrying)";

/**
 * Creates the shop-level and public (partner-level) signed clients for one run.
 *
 * @param options - `{accessToken, environment, fetchImpl}`; accessToken may be null (object)
 * @returns `{shop, public}` signed clients (object)
 */
export function createShopeeClients({ accessToken, environment, fetchImpl }) {
  return {
    shop: createSignedClient({ apiType: "shop", accessToken, environment, fetchImpl }),
    public: createSignedClient({ apiType: "public", accessToken: null, environment, fetchImpl }),
  };
}

/**
 * Picks the shop access token: node override, then SHOPEE_ACCESS_TOKEN, else null. Returning null lets
 * `refresh_access_token` run without one; shop operations then fail with auth_error.
 *
 * @param options - `{environment, nodeToken}` (object)
 * @returns Token or null (string | null)
 */
export function resolveShopeeAccessToken({ environment, nodeToken }) {
  return nodeToken || environment?.SHOPEE_ACCESS_TOKEN || null;
}

/**
 * Resolves the API host from SHOPEE_ENV (`live`, the default, or `test` for the sandbox).
 *
 * @param environment - Environment variables (object)
 * @returns Base URL (string)
 * @throws PluginError kind `invalid_input` - When SHOPEE_ENV has another value
 */
export function resolveShopeeBaseUrl(environment) {
  const environmentName = (environment?.SHOPEE_ENV || "live").trim().toLowerCase();
  const baseUrl = SHOPEE_HOSTS[environmentName];
  if (!baseUrl) rejectInput(`SHOPEE_ENV must be "live" or "test", not ${JSON.stringify(environment.SHOPEE_ENV)}`);
  return baseUrl;
}

function createSignedClient({ apiType, accessToken, environment, fetchImpl }) {
  const request = async ({ repeatedQuery, secrets = [], ...requestOptions }) => {
    const signingPath = validateApiPath(requestOptions.path);
    const credentials = readCredentials(apiType, accessToken, environment);
    const apiClient = createApiClient({
      baseUrl: resolveShopeeBaseUrl(environment),
      authorize: ({ query }) => signQuery(query, { ...credentials, path: signingPath, extraSecrets: secrets }),
      parseError: parseShopeeError,
      detectBodyError: (body) => detectShopeeBodyError(body, { isRead: isReadMethod(requestOptions.method) }),
      fetchImpl,
    });
    return apiClient.request({ ...requestOptions, path: appendRepeatedQuery(signingPath, repeatedQuery) });
  };
  return { request, readPartnerId: () => readCredentials("public", null, environment).partnerId };
}

function signQuery(query, { partnerId, partnerKey, accessToken, shopId, path, extraSecrets }) {
  const timestamp = Math.floor(Date.now() / 1000);
  Object.assign(query, { partner_id: partnerId, timestamp });
  if (accessToken) Object.assign(query, { access_token: accessToken, shop_id: shopId });
  query.sign = computeShopeeSignature({ partnerId, path, timestamp, accessToken: accessToken ?? "", shopId: accessToken ? shopId : "", partnerKey });
  return [partnerKey, accessToken, ...extraSecrets].filter(Boolean);
}

function readCredentials(apiType, accessToken, environment) {
  const partnerId = readNumericEnv(environment, "SHOPEE_PARTNER_ID");
  const partnerKey = environment?.SHOPEE_PARTNER_KEY;
  if (!partnerKey) throw missingCredential("SHOPEE_PARTNER_KEY");
  if (apiType === "public") return { partnerId, partnerKey };
  if (!accessToken) throw missingCredential("SHOPEE_ACCESS_TOKEN");
  return { partnerId, partnerKey, accessToken, shopId: readNumericEnv(environment, "SHOPEE_SHOP_ID") };
}

/**
 * Reads a numeric id (partner id, shop id) from the environment.
 *
 * @param environment - Environment variables (object)
 * @param variableName - Env var name (string)
 * @returns The id as a digit string (string)
 * @throws PluginError kind `auth_error` (missing) or `invalid_input` (not numeric)
 */
export function readNumericEnv(environment, variableName) {
  const rawValue = String(environment?.[variableName] ?? "").trim();
  if (!rawValue) throw missingCredential(variableName);
  if (!NUMERIC_ID_PATTERN.test(rawValue)) rejectInput(`${variableName} must be a number`);
  return rawValue;
}

function missingCredential(variableName) {
  return new PluginError(`No Shopee credential: set the ${variableName} environment variable (and allow it in permissions.env)`, {
    kind: "auth_error",
  });
}

function validateApiPath(path) {
  if (typeof path !== "string" || !API_PATH_PATTERN.test(path)) {
    rejectInput(`Shopee API path must look like "/api/v2/<module>/<function>" without a query string, got ${JSON.stringify(path)}`);
  }
  return path;
}

function appendRepeatedQuery(path, repeatedQuery) {
  const pairs = Object.entries(repeatedQuery ?? {}).flatMap(([name, values]) => values.map((value) => [name, String(value)]));
  return pairs.length === 0 ? path : `${path}?${new URLSearchParams(pairs)}`;
}

/**
 * Detects a Shopee error envelope (non-empty `error`), on any HTTP status.
 *
 * @param body - Parsed response body (object)
 * @returns `{message, kind, retryable?}` or null when the call succeeded (object | null)
 *
 * @example
 * detectShopeeError({ error: "error_auth", message: "Invalid access_token.", request_id: "r1" }).kind; // "auth_error"
 */
export function detectShopeeError(body) {
  const code = typeof body?.error === "string" ? body.error.trim() : "";
  if (!code) return null;
  const details = [code, body.request_id && `request_id ${body.request_id}`].filter(Boolean).join(", ");
  const detected = { message: `${body.message || code} (${details})`, kind: kindForShopeeCode(code) };
  return NOT_RETRYABLE_CODES.has(code) ? { ...detected, retryable: false } : detected;
}

/**
 * Checks a 2xx Shopee body: a missing envelope or an error code becomes an error. Server failure codes
 * (error_server, error_inner, error_busy, error_network) are retryable on reads; on writes they, and missing
 * envelopes, carry an "outcome unknown" note instead.
 *
 * @param body - Parsed response body; non-JSON arrives as `{text}` (object)
 * @param requestContext - `{isRead}`: true for GET requests (object)
 * @returns `{message, kind, retryable?}` or null when the call succeeded (object | null)
 *
 * @example
 * detectShopeeBodyError({ error: "error_busy", message: "busy" }, { isRead: true }).retryable; // true
 */
export function detectShopeeBodyError(body, { isRead }) {
  const outcomeNote = isRead ? "" : UNKNOWN_OUTCOME_NOTE;
  if (!hasShopeeEnvelope(body)) {
    return { message: `response without the Shopee error envelope${outcomeNote}`, kind: "api_error", retryable: false };
  }
  const detected = detectShopeeError(body);
  if (!detected || !SERVER_FAILURE_CODES.has(body.error.trim())) return detected;
  return isRead ? { ...detected, retryable: true } : { ...detected, message: `${detected.message}${outcomeNote}`, retryable: false };
}

function hasShopeeEnvelope(body) {
  return body !== null && typeof body === "object" && typeof body.error === "string";
}

function isReadMethod(method) {
  return (method ?? "GET").toUpperCase() === "GET";
}

/**
 * Maps a non-2xx response; bodies without a Shopee envelope fall back to the HTTP status mapping.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed response body (object)
 * @returns `{message, kind?, retryable?}` or `{}` (object)
 */
export function parseShopeeError(status, body) {
  const detected = detectShopeeError(body);
  if (!detected) return {};
  // api_error is left to the status mapping, so 5xx on reads stays retryable and 4xx keeps its HTTP kind.
  return detected.kind === "api_error" ? { message: detected.message } : detected;
}

function kindForShopeeCode(code) {
  if (ERROR_KINDS[code]) return ERROR_KINDS[code];
  if (code.startsWith("error_param")) return "invalid_input";
  if (code.includes("not_found") || code.includes("not_exist")) return "not_found";
  if (code.includes("permission")) return "permission_denied";
  return "api_error";
}

/**
 * Returns the useful part of a Shopee body: `response` when present, else the body without the envelope fields.
 *
 * @param body - Parsed response body (object)
 * @returns Payload (object)
 */
export function extractShopeeResponse(body) {
  if (body?.response !== undefined) return body.response;
  const { request_id: _requestId, error: _error, message: _message, ...payload } = body ?? {};
  return payload;
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

/**
 * Returns a copy of a PluginError with the given secrets removed from its message.
 *
 * @param error - Error thrown by a client call (Error)
 * @param secrets - Values that must not appear (Array<string | undefined>)
 * @returns The redacted PluginError, or the original error when it is not a PluginError (Error)
 */
export function redactPluginError(error, secrets) {
  if (!(error instanceof PluginError)) return error;
  const secretValues = secrets.filter((secretValue) => typeof secretValue === "string" && secretValue.length >= 4);
  const message = secretValues.reduce((redactedText, secretValue) => redactedText.split(secretValue).join("[redacted]"), error.message);
  return new PluginError(message, { kind: error.kind, retryable: error.retryable, retryAfterMs: error.retryAfterMs });
}
