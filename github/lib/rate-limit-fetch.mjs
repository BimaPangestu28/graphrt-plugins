/**
 * GitHub reports an exhausted rate limit as 403 (sometimes 429) with `x-ratelimit-remaining: 0`, a `retry-after`
 * header (secondary limits) or a "rate limit" message. The shared client maps 403 to permission_denied, so this fetch
 * wrapper rewrites such responses to 429 with a `retry-after` in seconds (from `x-ratelimit-reset` when GitHub gives
 * no retry-after); the client then reports `rate_limited` with `retryAfterMs` and only waits when that is short.
 */

const RATE_LIMIT_STATUSES = new Set([403, 429]);
const DEFAULT_WAIT_SECONDS = 60;

/**
 * Wraps a fetch so GitHub rate-limit responses become HTTP 429 with `retry-after`.
 *
 * @param fetchImpl - The fetch to wrap (function)
 * @param now - Clock in milliseconds, for tests (function, default Date.now)
 * @returns A fetch with the same signature (function)
 *
 * @example
 * const fetchWithLimits = detectRateLimits(globalThis.fetch);
 */
export function detectRateLimits(fetchImpl, now = Date.now) {
  return async (url, init) => {
    const response = await fetchImpl(url, init);
    if (!RATE_LIMIT_STATUSES.has(response.status)) return response;
    const bodyText = await response.text();
    if (!isRateLimited(response, bodyText)) return rebuildResponse(response, bodyText);
    const headers = new Headers(response.headers);
    headers.set("retry-after", String(computeWaitSeconds(response.headers, now)));
    return new Response(bodyText, { status: 429, statusText: "Too Many Requests", headers });
  };
}

function isRateLimited(response, bodyText) {
  if (response.status === 429) return true;
  if (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")) return true;
  return /rate limit/i.test(bodyText);
}

function computeWaitSeconds(headers, now) {
  const retryAfterSeconds = Number(headers.get("retry-after"));
  if (headers.has("retry-after") && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) return Math.ceil(retryAfterSeconds);
  const resetEpochSeconds = Number(headers.get("x-ratelimit-reset"));
  if (headers.has("x-ratelimit-reset") && Number.isFinite(resetEpochSeconds)) return Math.max(0, Math.ceil(resetEpochSeconds - now() / 1000));
  return DEFAULT_WAIT_SECONDS;
}

// The body was consumed to read the message, so the response is rebuilt unchanged.
function rebuildResponse(response, bodyText) {
  return new Response(bodyText, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * Returns the definition with its client's fetch wrapped by detectRateLimits.
 *
 * @param pluginDefinition - Definition from defineRestPlugin (object)
 * @returns A new definition (object)
 */
export function withRateLimitDetection(pluginDefinition) {
  const createClient = (clientOptions) => {
    const baseFetch = clientOptions.fetchImpl ?? ((...fetchArguments) => globalThis.fetch(...fetchArguments));
    return pluginDefinition.createClient({ ...clientOptions, fetchImpl: detectRateLimits(baseFetch) });
  };
  return { ...pluginDefinition, createClient };
}
