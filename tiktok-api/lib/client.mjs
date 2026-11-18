/**
 * TikTok clients: the Open API (Display, Content Posting, OAuth) and the
 * Business API (comments, direct messages). Each has its own credentials and
 * error envelope, so the plugin builds one shared API client per API and
 * passes them to operations as `{open, business, oauth}`.
 *
 * Open API errors arrive as `{error: {code, message, log_id}}`, also on HTTP 200.
 * Business API errors arrive as `{code, message, request_id}` with code != 0.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const OPEN_API_BASE_URL = "https://open.tiktokapis.com";
export const BUSINESS_API_BASE_URL = "https://business-api.tiktok.com/open_api/v1.3";
const OPEN_API_KINDS = {
  access_token_invalid: "auth_error",
  scope_not_authorized: "permission_denied",
  scope_permission_missed: "permission_denied",
  url_ownership_unverified: "permission_denied",
  token_not_authorized_for_specified_publish_id: "permission_denied",
  reached_active_user_cap: "permission_denied",
  rate_limit_exceeded: "rate_limited",
  invalid_param: "invalid_input",
  invalid_params: "invalid_input",
  invalid_publish_id: "invalid_input",
  invalid_file_upload: "invalid_input",
  picture_size_check_failed: "invalid_input",
  privacy_level_option_mismatch: "invalid_input",
};
const OPEN_API_KIND_PREFIXES = [
  ["spam_risk_", "permission_denied"],
  ["unaudited_client_", "permission_denied"],
];
const OAUTH_KINDS = {
  invalid_grant: "auth_error",
  invalid_client: "auth_error",
  access_denied: "permission_denied",
  invalid_request: "invalid_input",
  invalid_scope: "invalid_input",
  rate_limit_exceeded: "rate_limited",
};
// Business API codes as documented for TikTok API for Business; not live-verified for the comment/message endpoints.
const BUSINESS_KINDS = { 40001: "permission_denied", 40002: "invalid_input", 40100: "rate_limited" };

/**
 * Creates the Open API, Business API and OAuth clients for one run.
 *
 * @param options - `{accessToken, environment, fetchImpl}`; accessToken is the Open API token or null (object)
 * @returns `{open, business, oauth}` shared API clients (object)
 */
export function createTiktokClients({ accessToken, environment, fetchImpl }) {
  return {
    open: createOpenApiClient(accessToken, fetchImpl),
    business: createBusinessApiClient(environment?.TIKTOK_BUSINESS_ACCESS_TOKEN, fetchImpl),
    oauth: createOAuthClient(environment, fetchImpl),
  };
}

/**
 * Picks the Open API token: node override, then TIKTOK_ACCESS_TOKEN, else null.
 * Returning null (instead of failing) lets business-only runs proceed; the
 * Open API client fails with auth_error when it is actually used.
 *
 * @param options - `{environment, nodeToken}` (object)
 * @returns Token or null (string | null)
 */
export function resolveOpenApiToken({ environment, nodeToken }) {
  return nodeToken || environment?.TIKTOK_ACCESS_TOKEN || null;
}

function createOpenApiClient(accessToken, fetchImpl) {
  return createApiClient({
    baseUrl: OPEN_API_BASE_URL,
    authorize: ({ headers }) => {
      if (!accessToken) throw missingCredential("TIKTOK_ACCESS_TOKEN", "Open API operations");
      headers.authorization = `Bearer ${accessToken}`;
    },
    parseError: parseOpenApiError,
    detectBodyError: detectOpenApiError,
    fetchImpl,
  });
}

function createBusinessApiClient(businessToken, fetchImpl) {
  const secrets = [businessToken];
  return createApiClient({
    baseUrl: BUSINESS_API_BASE_URL,
    authorize: ({ headers }) => {
      if (!businessToken) throw missingCredential("TIKTOK_BUSINESS_ACCESS_TOKEN", "Business API operations (comments, messages)");
      headers["access-token"] = businessToken;
    },
    parseError: (status, body) => redactParsed(detectBusinessError(body) ?? {}, secrets),
    detectBodyError: (body) => redactParsed(detectBusinessError(body), secrets),
    fetchImpl,
  });
}

// The token endpoint takes no bearer token; the client secret travels in the form body.
// The per-call refresh token is redacted by the refresh operation (see redactPluginError).
function createOAuthClient(environment, fetchImpl) {
  const secrets = [environment?.TIKTOK_CLIENT_SECRET, environment?.TIKTOK_REFRESH_TOKEN];
  return createApiClient({
    baseUrl: OPEN_API_BASE_URL,
    parseError: (status, body) => redactParsed(detectOAuthError(body) ?? detectOpenApiError(body) ?? {}, secrets),
    detectBodyError: (body) => redactParsed(detectOAuthError(body) ?? detectOpenApiError(body), secrets),
    fetchImpl,
  });
}

function missingCredential(environmentName, usage) {
  return new PluginError(`No TikTok credential for ${usage}: set the ${environmentName} environment variable (and allow it in permissions.env)`, {
    kind: "auth_error",
  });
}

/**
 * Detects an Open API error envelope (`error.code` other than "ok").
 *
 * @param body - Parsed response body (object)
 * @returns `{message, kind}` or null when the call succeeded (object | null)
 */
export function detectOpenApiError(body) {
  const openApiError = body?.error;
  if (!openApiError || typeof openApiError !== "object" || !openApiError.code || openApiError.code === "ok") return null;
  const code = String(openApiError.code);
  const details = [code, openApiError.log_id && `log_id ${openApiError.log_id}`].filter(Boolean).join(", ");
  return { message: `${openApiError.message || code} (${details})`, kind: kindForOpenApiCode(code) };
}

/**
 * Maps a non-2xx Open API response; non-TikTok bodies fall back to the HTTP status mapping.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed response body (object)
 * @returns `{message, kind}` or `{}` (object)
 */
export function parseOpenApiError(status, body) {
  const detected = detectOpenApiError(body) ?? detectOAuthError(body);
  if (!detected) return {};
  return detected.kind === "api_error" ? { message: detected.message } : detected;
}

function kindForOpenApiCode(code) {
  if (OPEN_API_KINDS[code]) return OPEN_API_KINDS[code];
  const prefixMatch = OPEN_API_KIND_PREFIXES.find(([prefix]) => code.startsWith(prefix));
  return prefixMatch ? prefixMatch[1] : "api_error";
}

/**
 * Detects an OAuth error body (`{error: "invalid_grant", error_description}`).
 *
 * @param body - Parsed response body (object)
 * @returns `{message, kind}` or null (object | null)
 */
export function detectOAuthError(body) {
  if (typeof body?.error !== "string" || body.error === "") return null;
  const details = [body.error, body.log_id && `log_id ${body.log_id}`].filter(Boolean).join(", ");
  return { message: `${body.error_description || body.error} (${details})`, kind: OAUTH_KINDS[body.error] ?? "api_error" };
}

/**
 * Detects a Business API error (`code` other than 0).
 *
 * @param body - Parsed response body (object)
 * @returns `{message, kind}` or null when the call succeeded (object | null)
 */
export function detectBusinessError(body) {
  if (body?.code === undefined || body.code === null || Number(body.code) === 0) return null;
  const code = Number(body.code);
  const details = [`code ${code}`, body.request_id && `request_id ${body.request_id}`].filter(Boolean).join(", ");
  return { message: `${body.message || "Business API error"} (${details})`, kind: kindForBusinessCode(code) };
}

function kindForBusinessCode(code) {
  if (BUSINESS_KINDS[code]) return BUSINESS_KINDS[code];
  if (code > 40100 && code < 40200) return "auth_error";
  if (code >= 40000 && code < 50000) return "invalid_input";
  return "api_error";
}

function redactParsed(parsedError, secrets) {
  if (!parsedError?.message) return parsedError;
  return { ...parsedError, message: redactText(parsedError.message, secrets) };
}

function redactText(text, secrets) {
  const secretValues = secrets.filter((secretValue) => typeof secretValue === "string" && secretValue.length >= 4);
  return secretValues.reduce((redactedText, secretValue) => redactedText.split(secretValue).join("[redacted]"), text);
}

/**
 * Returns a copy of a PluginError with the given secrets removed from its message.
 *
 * @param error - Error thrown by a client call (Error)
 * @param secrets - Values that must not appear (Array<string | undefined>)
 * @returns PluginError with the same kind and retry hints (PluginError)
 */
export function redactPluginError(error, secrets) {
  if (!(error instanceof PluginError)) return error;
  return new PluginError(redactText(error.message, secrets), { kind: error.kind, retryable: error.retryable, retryAfterMs: error.retryAfterMs });
}

/**
 * Converts a TikTok `{<list>, cursor, has_more}` payload into the operation output shape.
 *
 * @param payload - The `data` object of a list response (object)
 * @param listKey - Property holding the items, e.g. "videos" (string)
 * @returns `{data, next_cursor}`; data is the whole payload when listKey is absent (object)
 */
export function toCursorPage(payload, listKey) {
  const items = Array.isArray(payload?.[listKey]) ? payload[listKey] : (payload ?? []);
  const hasCursor = payload?.cursor !== undefined && payload?.cursor !== null;
  return { data: items, next_cursor: payload?.has_more && hasCursor ? String(payload.cursor) : null };
}

/**
 * Reads the Business API business_id from the arguments or TIKTOK_BUSINESS_ID.
 *
 * @param providedId - Id from the arguments (string | undefined)
 * @param environment - Environment variables (object)
 * @returns The business id (string)
 * @throws PluginError kind `invalid_input` - When neither is set
 */
export function resolveBusinessId(providedId, environment) {
  const businessId = providedId || environment?.TIKTOK_BUSINESS_ID;
  if (!businessId) rejectInput("Pass `business_id` or set the TIKTOK_BUSINESS_ID environment variable");
  return businessId;
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
