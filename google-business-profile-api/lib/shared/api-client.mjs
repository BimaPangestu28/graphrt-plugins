/**
 * Small HTTP client shared by the social-media plugins.
 *
 * Responsibilities: build URLs, attach credentials, encode JSON/form bodies,
 * retry safely (429 always, 5xx/network only for idempotent methods), honour
 * Retry-After, and turn failures into PluginErrors with stable `kind`s:
 * invalid_input, auth_error, permission_denied, not_found, rate_limited,
 * api_error, network_error, cancelled.
 *
 * Credentials never appear in error messages.
 */
import { PluginError } from "./graphrt-plugin.mjs";
import { sleepUnlessCancelled } from "./sleep.mjs";

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);
const MAX_RETRY_WAIT_MS = 60000;
const UNKNOWN_OUTCOME_NOTE = " (outcome unknown: the write may have been applied; check before retrying)";
const STATUS_KINDS = { 400: "invalid_input", 401: "auth_error", 403: "permission_denied", 404: "not_found", 422: "invalid_input" };

/**
 * Creates an API client bound to one base URL.
 *
 * @param options - Client configuration (object)
 * @param options.baseUrl - API root, e.g. "https://graph.facebook.com/v24.0" (string)
 * @param options.authorize - Adds credentials: `({headers, query}) => void | string[]`, may be async; any
 *   returned strings are extra secrets to redact (function)
 * @param options.parseError - Optional `(status, body, headers) => {message?, kind?, retryAfterMs?}` (function)
 * @param options.detectBodyError - Optional `(body, headers) => {message, kind?, retryAfterMs?} | null`, for APIs
 *   that report errors inside 2xx bodies (function)
 * @param options.refreshCredentials - Optional `async () => boolean`; called once on 401, retry if true (function)
 * @param options.fetchImpl - fetch implementation, for tests (function)
 * @param options.maxRetries - Retries after the first attempt (number, default 2)
 * @param options.retryBaseDelayMs - First backoff delay (number, default 1000)
 * @param options.timeoutMs - Per-attempt timeout (number, default 30000)
 * @param options.defaultHeaders - Headers sent on every request (object)
 * @returns `{request, requestWithHeaders}`; request options are
 *   `{method, path, query, json, form, body, headers, signal, redactResponse, timeoutMs}`
 *   (`timeoutMs` overrides the client's per-attempt timeout, e.g. for large uploads)
 *
 * @example
 * const client = createApiClient({ baseUrl, authorize: ({ headers }) => { headers.authorization = `Bearer ${token}`; } });
 * const me = await client.request({ path: "/me", query: { fields: ["id", "name"] } });
 */
export function createApiClient(options) {
  // Drop undefined options so callers can pass e.g. `fetchImpl: undefined` without losing the default.
  const providedOptions = Object.fromEntries(Object.entries(options).filter(([, optionValue]) => optionValue !== undefined));
  const clientSettings = {
    fetchImpl: (...fetchArguments) => globalThis.fetch(...fetchArguments),
    maxRetries: 2,
    retryBaseDelayMs: 1000,
    timeoutMs: 30000,
    defaultHeaders: {},
    parseError: () => ({}),
    ...providedOptions,
  };
  const requestWithHeaders = (requestOptions) => sendWithRetries(clientSettings, requestOptions);
  const request = async (requestOptions) => (await requestWithHeaders(requestOptions)).body;
  return { request, requestWithHeaders };
}

async function sendWithRetries(clientSettings, requestOptions) {
  const method = (requestOptions.method ?? "GET").toUpperCase();
  const normalizedOptions = { ...requestOptions, method };
  let preparedRequest = await prepareRequest(clientSettings, normalizedOptions);
  let hasRefreshedCredentials = false;
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await sendOnce(clientSettings, preparedRequest, requestOptions.signal);
    if (outcome.response) return finalizeResponse(outcome.response, requestOptions, preparedRequest.secrets);
    if (await shouldRetryWithFreshCredentials(clientSettings, outcome.error, hasRefreshedCredentials)) {
      hasRefreshedCredentials = true;
      preparedRequest = await prepareRequest(clientSettings, normalizedOptions);
      continue;
    }
    if (attempt >= clientSettings.maxRetries || !outcome.error.retryable) throw outcome.error;
    await waitBeforeRetry(clientSettings, outcome.error, attempt, requestOptions.signal);
  }
}

async function shouldRetryWithFreshCredentials(clientSettings, pluginError, hasRefreshedCredentials) {
  if (hasRefreshedCredentials || pluginError.kind !== "auth_error" || !clientSettings.refreshCredentials) return false;
  return Boolean(await clientSettings.refreshCredentials());
}

function finalizeResponse(response, requestOptions, secrets) {
  if (!requestOptions.redactResponse) return response;
  return { ...response, body: redactDeep(response.body, secrets) };
}

async function prepareRequest(clientSettings, requestOptions) {
  rejectBodyOnReadMethods(requestOptions);
  const headers = { accept: "application/json", ...clientSettings.defaultHeaders, ...requestOptions.headers };
  const query = { ...requestOptions.query };
  const extraSecrets = await clientSettings.authorize?.({ headers, query });
  const url = buildUrl(clientSettings.baseUrl, requestOptions.path, query);
  const body = encodeBody(requestOptions, headers);
  const secrets = collectSecrets(headers, query, extraSecrets);
  const timeoutMs = requestOptions.timeoutMs ?? clientSettings.timeoutMs;
  return { url, method: requestOptions.method, init: { method: requestOptions.method, headers, body }, secrets, timeoutMs };
}

function rejectBodyOnReadMethods(requestOptions) {
  const hasBody = requestOptions.json !== undefined || requestOptions.form !== undefined || requestOptions.body !== undefined;
  if (hasBody && (requestOptions.method === "GET" || requestOptions.method === "HEAD")) {
    throw new PluginError(`A ${requestOptions.method} request cannot have a body; use query parameters instead`, { kind: "invalid_input" });
  }
}

function buildUrl(baseUrl, path, query) {
  const base = new URL(baseUrl);
  const url = /^https?:\/\//i.test(String(path)) ? new URL(path) : resolveRelativePath(base, path);
  if (url.origin !== base.origin) {
    throw new PluginError(`Refusing to call ${url.origin}: only ${base.origin} is allowed`, { kind: "invalid_input" });
  }
  for (const [queryName, queryValue] of Object.entries(query)) {
    if (queryValue === undefined || queryValue === null) continue;
    url.searchParams.set(queryName, encodeQueryValue(queryValue));
  }
  return url.toString();
}

// Relative paths are joined to the base path; anything that could escape it
// ("//host", backslashes, dot segments) is refused so the token stays on the API.
function resolveRelativePath(base, path) {
  const isSafePath =
    typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") && !/(^|\/)\.\.?(\/|$|\?|#)/.test(path);
  if (!isSafePath) {
    throw new PluginError(`Unsafe API path ${JSON.stringify(path)}: use "/segment/..." without "//", "\\" or dot segments`, {
      kind: "invalid_input",
    });
  }
  return new URL(base.pathname.replace(/\/$/, "") + path, base.origin);
}

function encodeQueryValue(queryValue) {
  const isPrimitiveList = Array.isArray(queryValue) && queryValue.every((item) => typeof item !== "object" || item === null);
  if (isPrimitiveList) return queryValue.join(",");
  return typeof queryValue === "object" ? JSON.stringify(queryValue) : String(queryValue);
}

function encodeBody(requestOptions, headers) {
  if (requestOptions.json !== undefined) {
    headers["content-type"] = "application/json";
    return JSON.stringify(requestOptions.json);
  }
  if (requestOptions.form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    const formEntries = Object.entries(requestOptions.form).filter(([, formValue]) => formValue !== undefined && formValue !== null);
    return new URLSearchParams(formEntries.map(([formName, formValue]) => [formName, encodeFormValue(formValue)])).toString();
  }
  return requestOptions.body;
}

function encodeFormValue(formValue) {
  return typeof formValue === "object" ? JSON.stringify(formValue) : String(formValue);
}

function collectSecrets(headers, query, extraSecrets) {
  const declaredSecrets = Array.isArray(extraSecrets) ? extraSecrets : [];
  const secretValues = [headers.authorization, query.access_token, query.key, ...declaredSecrets].filter(Boolean).map(String);
  const bearerTokens = secretValues.map((secretValue) => secretValue.replace(/^(Bearer|Basic)\s+/i, ""));
  return [...new Set([...secretValues, ...bearerTokens])].filter((secretValue) => secretValue.length >= 4);
}

async function sendOnce(clientSettings, preparedRequest, callerSignal) {
  const timeoutSignal = AbortSignal.timeout(preparedRequest.timeoutMs);
  const combinedSignal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  let fetchResponse;
  let responseBody;
  try {
    fetchResponse = await clientSettings.fetchImpl(preparedRequest.url, { ...preparedRequest.init, signal: combinedSignal });
    responseBody = await readBody(fetchResponse);
  } catch (transportError) {
    return { error: classifyTransportFailure(transportError, callerSignal, preparedRequest) };
  }
  if (fetchResponse.ok) {
    const bodyError = clientSettings.detectBodyError?.(responseBody, fetchResponse.headers);
    if (bodyError) return { error: buildBodyError(bodyError, preparedRequest.secrets) };
    return { response: { body: responseBody, headers: fetchResponse.headers, status: fetchResponse.status } };
  }
  return { error: buildHttpError(clientSettings, fetchResponse, responseBody, preparedRequest) };
}

function classifyTransportFailure(transportError, callerSignal, preparedRequest) {
  if (callerSignal?.aborted) return new PluginError("Request cancelled", { kind: "cancelled" });
  const isTimeout = transportError?.name === "TimeoutError";
  const reason = isTimeout ? "request timed out" : String(transportError?.cause?.message ?? transportError?.message ?? transportError);
  const isIdempotent = IDEMPOTENT_METHODS.has(preparedRequest.method);
  const message = `Network error: ${reason}${isIdempotent ? "" : UNKNOWN_OUTCOME_NOTE}`;
  return new PluginError(redact(message, preparedRequest.secrets), { kind: "network_error", retryable: isIdempotent });
}

async function readBody(fetchResponse) {
  const responseText = await fetchResponse.text();
  if (responseText === "") return {};
  try {
    return JSON.parse(responseText);
  } catch {
    return { text: responseText };
  }
}

function buildHttpError(clientSettings, fetchResponse, responseBody, preparedRequest) {
  const status = fetchResponse.status;
  const parsedError = clientSettings.parseError(status, responseBody, fetchResponse.headers) ?? {};
  const kind = parsedError.kind ?? defaultKindForStatus(status);
  const apiMessage = parsedError.message ?? extractGenericMessage(responseBody) ?? fetchResponse.statusText;
  const retryAfterMs = parsedError.retryAfterMs ?? parseRetryAfter(fetchResponse.headers.get("retry-after"));
  const isIdempotent = IDEMPOTENT_METHODS.has(preparedRequest.method);
  const isServerFailure = kind === "api_error" && status >= 500;
  const retryable = parsedError.retryable ?? (kind === "rate_limited" || (isServerFailure && isIdempotent));
  const outcomeNote = isServerFailure && !isIdempotent ? UNKNOWN_OUTCOME_NOTE : "";
  return new PluginError(redact(`API error ${status}: ${apiMessage}${outcomeNote}`, preparedRequest.secrets), {
    kind,
    retryable,
    retryAfterMs: retryAfterMs ?? undefined,
  });
}

function buildBodyError(bodyError, secrets) {
  const kind = bodyError.kind ?? "api_error";
  return new PluginError(redact(`API error: ${bodyError.message}`, secrets), {
    kind,
    retryable: bodyError.retryable ?? kind === "rate_limited",
    retryAfterMs: bodyError.retryAfterMs,
  });
}

function defaultKindForStatus(status) {
  if (status === 429) return "rate_limited";
  return STATUS_KINDS[status] ?? "api_error";
}

function extractGenericMessage(responseBody) {
  const candidates = [
    responseBody?.error?.message,
    responseBody?.error_description,
    typeof responseBody?.error === "string" ? responseBody.error : undefined,
    responseBody?.detail,
    responseBody?.message,
    responseBody?.title,
    responseBody?.errors?.[0]?.message,
    responseBody?.text,
  ];
  return candidates.find((candidate) => typeof candidate === "string" && candidate !== "");
}

function parseRetryAfter(retryAfterHeader) {
  if (retryAfterHeader === null || retryAfterHeader === undefined) return null;
  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const retryDate = Date.parse(retryAfterHeader);
  return Number.isNaN(retryDate) ? null : Math.max(0, retryDate - Date.now());
}

async function waitBeforeRetry(clientSettings, pluginError, attempt, callerSignal) {
  const backoffMs = clientSettings.retryBaseDelayMs * 2 ** attempt;
  const waitMs = pluginError.retryAfterMs ?? backoffMs;
  if (waitMs > MAX_RETRY_WAIT_MS) throw pluginError;
  await sleepUnlessCancelled(waitMs, callerSignal, "Request cancelled");
}

function redact(text, secrets) {
  return secrets.reduce((redactedText, secretValue) => redactedText.split(secretValue).join("[redacted]"), text);
}

function redactDeep(value, secrets) {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryName, entryValue]) => [entryName, redactDeep(entryValue, secrets)]));
  }
  return value;
}
