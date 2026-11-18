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

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);
const MAX_RETRY_WAIT_MS = 60000;
const STATUS_KINDS = { 400: "invalid_input", 401: "auth_error", 403: "permission_denied", 404: "not_found", 422: "invalid_input" };

/**
 * Creates an API client bound to one base URL.
 *
 * @param options - Client configuration (object)
 * @param options.baseUrl - API root, e.g. "https://graph.facebook.com/v24.0" (string)
 * @param options.authorize - Adds credentials: `({headers, query}) => void | Promise<void>` (function)
 * @param options.parseError - Optional `(status, body, headers) => {message?, kind?, retryAfterMs?}` (function)
 * @param options.detectBodyError - Optional `(body, headers) => {message, kind?, retryAfterMs?} | null`, for APIs
 *   that report errors inside 2xx bodies (function)
 * @param options.refreshCredentials - Optional `async () => boolean`; called once on 401, retry if true (function)
 * @param options.fetchImpl - fetch implementation, for tests (function)
 * @param options.maxRetries - Retries after the first attempt (number, default 2)
 * @param options.retryBaseDelayMs - First backoff delay (number, default 1000)
 * @param options.timeoutMs - Per-attempt timeout (number, default 30000)
 * @param options.defaultHeaders - Headers sent on every request (object)
 * @returns `{request, requestWithHeaders}`
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
  let preparedRequest = await prepareRequest(clientSettings, { ...requestOptions, method });
  let hasRefreshedCredentials = false;
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await sendOnce(clientSettings, preparedRequest, requestOptions.signal);
    if (outcome.response) return outcome.response;
    if (await shouldRetryWithFreshCredentials(clientSettings, outcome.error, hasRefreshedCredentials)) {
      hasRefreshedCredentials = true;
      preparedRequest = await prepareRequest(clientSettings, { ...requestOptions, method });
      continue;
    }
    const canRetry = attempt < clientSettings.maxRetries && isRetryable(outcome.error, method);
    if (!canRetry) throw outcome.error;
    await waitBeforeRetry(clientSettings, outcome.error, attempt, requestOptions.signal);
  }
}

async function shouldRetryWithFreshCredentials(clientSettings, pluginError, hasRefreshedCredentials) {
  if (hasRefreshedCredentials || pluginError.kind !== "auth_error" || !clientSettings.refreshCredentials) return false;
  return Boolean(await clientSettings.refreshCredentials());
}

async function prepareRequest(clientSettings, requestOptions) {
  const headers = { accept: "application/json", ...clientSettings.defaultHeaders, ...requestOptions.headers };
  const query = { ...requestOptions.query };
  await clientSettings.authorize?.({ headers, query });
  const url = buildUrl(clientSettings.baseUrl, requestOptions.path, query);
  const body = encodeBody(requestOptions, headers);
  const secrets = collectSecrets(headers, query);
  return { url, init: { method: requestOptions.method, headers, body }, secrets };
}

function buildUrl(baseUrl, path, query) {
  const base = new URL(baseUrl);
  let url;
  if (/^https?:\/\//i.test(path)) {
    url = new URL(path);
    if (url.origin !== base.origin) {
      throw new PluginError(`Refusing to call ${url.origin}: only ${base.origin} is allowed`, { kind: "invalid_input" });
    }
  } else {
    url = new URL(base.pathname.replace(/\/$/, "") + path, base.origin);
  }
  for (const [queryName, queryValue] of Object.entries(query)) {
    if (queryValue === undefined || queryValue === null) continue;
    url.searchParams.set(queryName, Array.isArray(queryValue) ? queryValue.join(",") : String(queryValue));
  }
  return url.toString();
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

function collectSecrets(headers, query) {
  const secretValues = [headers.authorization, query.access_token, query.key].filter(Boolean).map(String);
  const bearerTokens = secretValues.map((secretValue) => secretValue.replace(/^Bearer\s+/i, ""));
  return [...new Set([...secretValues, ...bearerTokens])].filter((secretValue) => secretValue.length >= 4);
}

async function sendOnce(clientSettings, preparedRequest, callerSignal) {
  const timeoutSignal = AbortSignal.timeout(clientSettings.timeoutMs);
  const combinedSignal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  let fetchResponse;
  try {
    fetchResponse = await clientSettings.fetchImpl(preparedRequest.url, { ...preparedRequest.init, signal: combinedSignal });
  } catch (fetchError) {
    return { error: classifyFetchFailure(fetchError, callerSignal, preparedRequest.secrets) };
  }
  const responseBody = await readBody(fetchResponse);
  if (fetchResponse.ok) {
    const bodyError = clientSettings.detectBodyError?.(responseBody, fetchResponse.headers);
    if (bodyError) return { error: buildBodyError(bodyError, preparedRequest.secrets) };
    return { response: { body: responseBody, headers: fetchResponse.headers, status: fetchResponse.status } };
  }
  return { error: buildHttpError(clientSettings, fetchResponse, responseBody, preparedRequest.secrets) };
}

function classifyFetchFailure(fetchError, callerSignal, secrets) {
  if (callerSignal?.aborted) return new PluginError("Request cancelled", { kind: "cancelled" });
  const isTimeout = fetchError?.name === "TimeoutError";
  const reason = isTimeout ? "request timed out" : String(fetchError?.cause?.message ?? fetchError?.message ?? fetchError);
  return new PluginError(redact(`Network error: ${reason}`, secrets), { kind: "network_error", retryable: true });
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

function buildHttpError(clientSettings, fetchResponse, responseBody, secrets) {
  const status = fetchResponse.status;
  const parsedError = clientSettings.parseError(status, responseBody, fetchResponse.headers) ?? {};
  const kind = parsedError.kind ?? defaultKindForStatus(status);
  const apiMessage = parsedError.message ?? extractGenericMessage(responseBody) ?? fetchResponse.statusText;
  const retryAfterMs = parsedError.retryAfterMs ?? parseRetryAfter(fetchResponse.headers.get("retry-after"));
  const isRetryableKind = kind === "rate_limited" || status >= 500;
  return new PluginError(redact(`API error ${status}: ${apiMessage}`, secrets), {
    kind,
    retryable: isRetryableKind,
    retryAfterMs: retryAfterMs ?? undefined,
  });
}

function buildBodyError(bodyError, secrets) {
  const kind = bodyError.kind ?? "api_error";
  return new PluginError(redact(`API error: ${bodyError.message}`, secrets), {
    kind,
    retryable: kind === "rate_limited",
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

function isRetryable(pluginError, method) {
  if (pluginError.kind === "rate_limited") return true;
  if (pluginError.kind === "network_error" || pluginError.kind === "api_error") {
    return pluginError.retryable && IDEMPOTENT_METHODS.has(method);
  }
  return false;
}

async function waitBeforeRetry(clientSettings, pluginError, attempt, callerSignal) {
  const backoffMs = clientSettings.retryBaseDelayMs * 2 ** attempt;
  const waitMs = pluginError.retryAfterMs ?? backoffMs;
  if (waitMs > MAX_RETRY_WAIT_MS) throw pluginError;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, waitMs);
    callerSignal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new PluginError("Request cancelled", { kind: "cancelled" }));
      },
      { once: true },
    );
  });
}

function redact(text, secrets) {
  return secrets.reduce((redactedText, secretValue) => redactedText.split(secretValue).join("[redacted]"), text);
}
