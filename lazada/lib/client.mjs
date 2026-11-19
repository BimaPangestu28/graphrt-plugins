/**
 * Signed Lazada Open Platform client.
 *
 * Every request carries the system parameters `app_key`, `timestamp` (milliseconds), `sign_method=sha256`,
 * `access_token` and `sign` in the query. Business parameters go in the query for GET and in an
 * x-www-form-urlencoded body for POST (as the lazop SDKs send them); the signature covers both (lib/signing.mjs).
 * The app secret and access token are returned from `authorize`, so the shared client redacts them from errors and
 * redactResponse bodies.
 *
 * Lazada answers most failures with HTTP 200 and `{"type": "ISV", "code": "IllegalAccessToken", "message": ...,
 * "request_id": ...}`; success is `{"code": "0", "data": ..., "request_id": ...}`. A 2xx body without `code` is an
 * api_error, since success cannot be confirmed. Operations receive `client = {request(options)}`.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { computeLazadaSignature, stringifyParameters } from "./signing.mjs";

export const LAZADA_HOSTS = {
  id: "https://api.lazada.co.id/rest",
  my: "https://api.lazada.com.my/rest",
  ph: "https://api.lazada.com.ph/rest",
  sg: "https://api.lazada.sg/rest",
  th: "https://api.lazada.co.th/rest",
  vn: "https://api.lazada.vn/rest",
};
const API_PATH_PATTERN = /^\/[a-z0-9_]+(\/[a-z0-9_]+)*$/i;
const UNKNOWN_OUTCOME_NOTE = " (outcome unknown: the write may have been applied; check before retrying)";
const KIND_PATTERNS = [
  [/accesstoken|signature|appkey|app_key|unauthori[sz]ed|illegalaccess/i, "auth_error"],
  [/calllimit|throttl|frequency|ratelimit|too_?many/i, "rate_limited"],
  [/permission|forbidden|accessdenied|insufficient/i, "permission_denied"],
  [/notfound|not_found|notexist|not_exist|nosuch/i, "not_found"],
  [/parameter|invalid|missing|illegal|^e\d+/i, "invalid_input"],
];
// Lazada system/ISP failures that say nothing was done yet; retried on reads only.
const SERVER_FAILURE_TYPES = new Set(["SYSTEM", "ISP"]);

/**
 * Resolves the regional API gateway from LAZADA_REGION.
 *
 * @param environment - Environment variables (object)
 * @returns Base URL, e.g. "https://api.lazada.co.id/rest" (string)
 * @throws PluginError kind `invalid_input` - LAZADA_REGION is missing or unknown
 */
export function resolveLazadaBaseUrl(environment) {
  const region = String(environment?.LAZADA_REGION ?? "").trim().toLowerCase();
  if (!LAZADA_HOSTS[region]) throw new PluginError(`LAZADA_REGION must be one of ${Object.keys(LAZADA_HOSTS).join(", ")} (the seller's country)`, { kind: "invalid_input" });
  return LAZADA_HOSTS[region];
}

/**
 * Creates the signed client for one run.
 *
 * @param options - `{accessToken, environment, fetchImpl}` (object)
 * @returns `{request({method, path, query, form, json, signal, redactResponse})}`; json is sent as form fields, and
 *   redactResponse defaults to true, so a secret echoed in a 200 body never reaches data (object)
 */
export function createLazadaClient({ accessToken, environment, fetchImpl }) {
  const request = async ({ method = "GET", path, query, form, json, signal, redactResponse = true }) => {
    const upperMethod = method.toUpperCase();
    const apiPath = validateApiPath(path);
    const credentials = readCredentials(accessToken, environment);
    const businessParameters = stringifyParameters(upperMethod === "GET" ? query : { ...query, ...json, ...form });
    const isRead = upperMethod === "GET";
    const apiClient = createApiClient({
      baseUrl: resolveLazadaBaseUrl(environment),
      authorize: ({ query: requestQuery }) => signRequest(requestQuery, { apiPath, credentials, businessParameters, isRead }),
      parseError: parseLazadaError,
      detectBodyError: (body) => detectLazadaBodyError(body, { isRead }),
      fetchImpl,
    });
    const placement = isRead ? { query: businessParameters } : { form: businessParameters };
    return apiClient.request({ method: upperMethod, path: apiPath, ...placement, signal, redactResponse });
  };
  return { request };
}

function signRequest(requestQuery, { apiPath, credentials, businessParameters, isRead }) {
  Object.assign(requestQuery, { app_key: credentials.appKey, timestamp: String(Date.now()), sign_method: "sha256", access_token: credentials.accessToken });
  const signedParameters = isRead ? { ...requestQuery } : { ...requestQuery, ...businessParameters };
  requestQuery.sign = computeLazadaSignature(credentials.appSecret, apiPath, signedParameters);
  return [credentials.appSecret, credentials.accessToken];
}

function readCredentials(accessToken, environment) {
  const appKey = String(environment?.LAZADA_APP_KEY ?? "").trim();
  const appSecret = String(environment?.LAZADA_APP_SECRET ?? "").trim();
  if (!appKey) throw missingCredential("LAZADA_APP_KEY");
  if (!/^\d+$/.test(appKey)) throw new PluginError("LAZADA_APP_KEY must be the numeric App Key", { kind: "invalid_input" });
  if (!appSecret) throw missingCredential("LAZADA_APP_SECRET");
  if (!accessToken) throw missingCredential("LAZADA_ACCESS_TOKEN");
  return { appKey, appSecret, accessToken };
}

function missingCredential(variableName) {
  return new PluginError(`No Lazada credential: set the ${variableName} environment variable (and allow it in permissions.env)`, { kind: "auth_error" });
}

function validateApiPath(path) {
  if (typeof path !== "string" || !API_PATH_PATTERN.test(path)) {
    throw new PluginError(`Lazada API path must look like "/orders/get" (no "/rest", no query string), got ${JSON.stringify(path)}`, { kind: "invalid_input" });
  }
  return path;
}

/**
 * Detects a Lazada error envelope (a `code` other than "0").
 *
 * @param body - Parsed response body (object)
 * @returns `{message, kind, retryable}` or null when the call succeeded or the body has no code (object | null)
 *
 * @example
 * detectLazadaError({ type: "ISV", code: "IllegalAccessToken", message: "The specified access token is invalid or expired" }).kind; // "auth_error"
 */
export function detectLazadaError(body) {
  if (body === null || typeof body !== "object" || body.code === undefined || String(body.code) === "0") return null;
  const code = String(body.code);
  const details = [code, body.request_id && `request_id ${body.request_id}`].filter(Boolean).join(", ");
  return { message: `${body.message || code} (${details})`, kind: kindForLazadaCode(code), isServerFailure: SERVER_FAILURE_TYPES.has(String(body.type ?? "").toUpperCase()) };
}

function kindForLazadaCode(code) {
  return KIND_PATTERNS.find(([pattern]) => pattern.test(code))?.[1] ?? "api_error";
}

/**
 * Checks a 2xx body: no `code` or a non-zero code becomes an error. Server failures are retryable on reads; on
 * writes they, and bodies without a code, say the outcome is unknown.
 *
 * @param body - Parsed body; non-JSON arrives as `{text}` (object)
 * @param requestContext - `{isRead}` (object)
 * @returns `{message, kind, retryable}` or null (object | null)
 */
export function detectLazadaBodyError(body, { isRead }) {
  const outcomeNote = isRead ? "" : UNKNOWN_OUTCOME_NOTE;
  if (body === null || typeof body !== "object" || body.code === undefined) {
    return { message: `response without the Lazada envelope (no code)${outcomeNote}`, kind: "api_error", retryable: false };
  }
  const detected = detectLazadaError(body);
  if (!detected) return null;
  const { isServerFailure, ...lazadaError } = detected;
  const kind = isServerFailure && lazadaError.kind === "invalid_input" ? "api_error" : lazadaError.kind;
  if (!isServerFailure) return { ...lazadaError, kind, retryable: kind === "rate_limited" && isRead };
  return isRead ? { ...lazadaError, kind, retryable: true } : { ...lazadaError, kind, message: `${lazadaError.message}${outcomeNote}`, retryable: false };
}

/**
 * Maps a non-2xx response; bodies without a Lazada envelope fall back to the HTTP status mapping.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed body (object)
 * @returns `{message, kind?}` or `{}` (object)
 */
export function parseLazadaError(status, body) {
  const detected = detectLazadaError(body);
  if (!detected) return {};
  return detected.kind === "api_error" ? { message: detected.message } : { message: detected.message, kind: detected.kind };
}

/**
 * Returns `data` of a Lazada success body.
 *
 * @param body - Parsed body (object)
 * @returns The payload (any)
 */
export function extractLazadaData(body) {
  return body?.data ?? body?.result ?? null;
}
