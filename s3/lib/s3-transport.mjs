/**
 * Signed S3 requests: URL building (virtual-hosted or path style), SigV4 signing, timeouts, cancellation,
 * retries and error mapping.
 *
 * Why not the shared api-client: object keys may contain "//" and other characters that client refuses, and S3
 * answers in XML. Keys are encoded segment by segment here; "." and ".." segments are refused, because fetch
 * would normalize them away and sign one URL while sending another.
 *
 * Every request in this plugin is idempotent (GET, HEAD, PUT of a whole object, copy onto a fixed key, DELETE),
 * so 5xx, 429/503 and network failures are retried twice with backoff. Redirects are not followed (a redirect
 * means the bucket is in another region; following it could send the signed request elsewhere). The secret key,
 * session token and Authorization header are redacted from every error message.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { sleepUnlessCancelled } from "./shared/sleep.mjs";
import { hashPayload, presignUrl, signRequestHeaders, uriEncode, UNSIGNED_PAYLOAD } from "./aws-sigv4.mjs";
import { buildS3Error, readS3ErrorBody } from "./s3-errors.mjs";

const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;
const MAX_KEY_BYTES = 1024;
const MAX_BUFFERED_BODY_BYTES = 8 * 1024 * 1024;
const BUCKET_PATTERN = /^[A-Za-z0-9._-]{1,255}$/;
const VIRTUAL_HOST_BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * Creates the transport for one run.
 *
 * @param options - Transport options (object)
 * @param options.settings - From resolveSettings (object)
 * @param options.credentials - From resolveCredentials (object)
 * @param options.fetchImpl - fetch implementation (function, default global fetch)
 * @param options.now - Clock for signing (function returning Date, default `() => new Date()`)
 * @param options.retryBaseDelayMs - First backoff delay, for tests (number, default 500)
 * @returns `{request, presignGet, buildUrl, redact}` (object)
 */
export function createS3Transport({ settings, credentials, fetchImpl, now = () => new Date(), retryBaseDelayMs = RETRY_BASE_DELAY_MS }) {
  const secrets = [credentials.secretAccessKey, credentials.sessionToken].filter((secretValue) => typeof secretValue === "string" && secretValue.length >= 4);
  const transportContext = { settings, credentials, fetchImpl: fetchImpl ?? ((...fetchArguments) => globalThis.fetch(...fetchArguments)), now, retryBaseDelayMs, secrets };
  const redact = (text) => redactSecrets(String(text), transportContext.secrets);
  return {
    request: (requestOptions) => sendWithRetries(transportContext, requestOptions, redact),
    presignGet: ({ bucket, key, query, expiresInSeconds }) =>
      presignUrl({ method: "GET", url: buildUrl(settings, bucket, key, query), payloadHash: UNSIGNED_PAYLOAD, credentials, region: settings.region, service: "s3", pathEncoding: "s3", now: now(), expiresInSeconds }),
    buildUrl: (bucket, key, query) => buildUrl(settings, bucket, key, query),
    redact,
  };
}

/**
 * Builds the request URL for a bucket and key.
 *
 * @param settings - `{endpoint, forcePathStyle}` (object)
 * @param bucket - Bucket name; undefined for service-level requests such as ListBuckets (string | undefined)
 * @param key - Object key; undefined for bucket-level requests (string | undefined)
 * @param query - Query parameters; undefined values are skipped (object, optional)
 * @returns Absolute URL, encoded exactly as it will be signed and sent (string)
 * @throws PluginError kind `invalid_input` - Invalid bucket name, empty/too long key, "." or ".." key segments
 */
export function buildUrl(settings, bucket, key, query = {}) {
  const queryString = encodeQuery(query);
  const suffix = queryString ? `?${queryString}` : "";
  if (bucket === undefined) return `${settings.endpoint}/${suffix}`;
  assertBucketName(bucket);
  const keyPath = key === undefined ? "" : `/${encodeKey(key)}`;
  if (!settings.forcePathStyle && VIRTUAL_HOST_BUCKET_PATTERN.test(bucket)) {
    const endpointUrl = new URL(settings.endpoint);
    return `${endpointUrl.protocol}//${bucket}.${endpointUrl.host}${keyPath || "/"}${suffix}`;
  }
  return `${settings.endpoint}/${uriEncode(bucket, true)}${keyPath}${suffix}`;
}

/**
 * Checks a bucket name (S3 rules plus the looser legacy and S3-compatible names).
 *
 * @param bucket - Bucket name (string)
 * @throws PluginError kind `invalid_input`
 */
export function assertBucketName(bucket) {
  if (typeof bucket !== "string" || !BUCKET_PATTERN.test(bucket) || bucket === "." || bucket === "..") {
    throw new PluginError(`Invalid bucket name ${JSON.stringify(bucket)}`, { kind: "invalid_input" });
  }
}

/**
 * URI-encodes an object key segment by segment ("/" is kept as the separator).
 *
 * @param key - Object key (string)
 * @returns Encoded key path without a leading slash (string)
 * @throws PluginError kind `invalid_input` - Empty key, more than 1024 UTF-8 bytes, or a "." / ".." segment
 */
export function encodeKey(key) {
  if (typeof key !== "string" || key === "") throw new PluginError("`key` must be a non-empty object key", { kind: "invalid_input" });
  if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) throw new PluginError("`key` is longer than 1024 bytes", { kind: "invalid_input" });
  const segments = key.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new PluginError("`key` must not contain \".\" or \"..\" path segments (they cannot be sent unchanged over HTTP)", { kind: "invalid_input" });
  }
  return segments.map((segment) => uriEncode(segment, true)).join("/");
}

function encodeQuery(query) {
  return Object.entries(query ?? {})
    .filter(([, queryValue]) => queryValue !== undefined && queryValue !== null)
    .map(([queryName, queryValue]) => `${uriEncode(queryName, true)}=${uriEncode(String(queryValue), true)}`)
    .join("&");
}

async function sendWithRetries(transportContext, requestOptions, redact) {
  const isIdempotent = requestOptions.idempotent !== false;
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await sendOnce(transportContext, requestOptions, redact, isIdempotent);
    if (!outcome.error) return outcome;
    if (attempt >= MAX_RETRIES || !outcome.error.retryable) throw outcome.error;
    await sleepUnlessCancelled(transportContext.retryBaseDelayMs * 2 ** attempt, requestOptions.signal, "S3 request cancelled");
  }
}

async function sendOnce(transportContext, requestOptions, redact, isIdempotent) {
  const { settings } = transportContext;
  const method = requestOptions.method ?? "GET";
  const url = buildUrl(settings, requestOptions.bucket, requestOptions.key, requestOptions.query);
  const ownerHeader = requestOptions.bucket !== undefined && settings.expectedBucketOwner ? { "x-amz-expected-bucket-owner": settings.expectedBucketOwner } : {};
  const headers = signHeaders(transportContext, { method, url, headers: { ...ownerHeader, ...requestOptions.headers }, body: requestOptions.body });
  const timeoutSignal = AbortSignal.timeout(requestOptions.timeoutMs ?? settings.timeoutMs);
  const signal = requestOptions.signal ? AbortSignal.any([requestOptions.signal, timeoutSignal]) : timeoutSignal;
  let response;
  try {
    response = await transportContext.fetchImpl(url, { method, headers, body: requestOptions.body, signal, redirect: "manual" });
  } catch (transportError) {
    return { error: classifyTransportError(transportError, requestOptions.signal, redact, isIdempotent) };
  }
  if (response.ok && requestOptions.stream) return { status: response.status, headers: response.headers, response, signal };
  return readResponse(response, { method, redact, isIdempotent, signal: requestOptions.signal });
}

function signHeaders({ settings, credentials, now }, { method, url, headers, body }) {
  const definedEntries = Object.entries(headers).filter(([, headerValue]) => headerValue !== undefined && headerValue !== null);
  const lowercaseHeaders = Object.fromEntries(definedEntries.map(([headerName, headerValue]) => [headerName.toLowerCase(), String(headerValue)]));
  const signingInputs = { method, url, headers: lowercaseHeaders, payloadHash: hashPayload(body), credentials, region: settings.region, service: "s3" };
  return { ...lowercaseHeaders, ...signRequestHeaders({ ...signingInputs, now: now(), pathEncoding: "s3", includeContentSha256Header: true }) };
}

async function readResponse(response, { method, redact, isIdempotent, signal }) {
  let bodyText;
  try {
    bodyText = method === "HEAD" ? "" : await readCappedBody(response, redact);
  } catch (readError) {
    return { error: classifyTransportError(readError, signal, redact, isIdempotent) };
  }
  // CopyObject can answer 200 and still fail: the error is in the body.
  const isErrorInSuccess = response.ok && readS3ErrorBody(bodyText).code !== undefined;
  if (response.ok && !isErrorInSuccess) return { status: response.status, headers: response.headers, bodyText };
  const status = isErrorInSuccess ? 500 : response.status;
  return { error: buildS3Error({ status, method, bodyText, regionHeader: response.headers.get("x-amz-bucket-region") ?? undefined, isIdempotent, redact }) };
}

// Listings, errors and copy results are small XML documents; anything far larger is not something to parse.
async function readCappedBody(response, redact) {
  if (!response.body) return "";
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_BUFFERED_BODY_BYTES) {
      throw new PluginError(redact(`S3 returned a response larger than ${MAX_BUFFERED_BODY_BYTES} bytes where a small XML document was expected`), { kind: "api_error" });
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function classifyTransportError(transportError, callerSignal, redact, isIdempotent) {
  if (transportError instanceof PluginError) return transportError;
  if (callerSignal?.aborted) return new PluginError("S3 request cancelled", { kind: "cancelled" });
  const isTimeout = transportError?.name === "TimeoutError" || transportError?.name === "AbortError";
  const reason = isTimeout ? "request timed out" : String(transportError?.cause?.code ?? transportError?.cause?.message ?? transportError?.message ?? transportError);
  const outcomeNote = isIdempotent ? "" : " (outcome unknown: the write may have been applied; check before retrying)";
  return new PluginError(redact(`Network error calling S3: ${reason}${outcomeNote}`), { kind: "network_error", retryable: isIdempotent });
}

function redactSecrets(text, secrets) {
  return secrets.reduce((redactedText, secretValue) => redactedText.split(secretValue).join("[redacted]"), text);
}
