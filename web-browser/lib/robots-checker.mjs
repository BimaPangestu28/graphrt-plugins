/**
 * robots.txt enforcement with a small per-origin cache.
 *
 * The file is fetched from Node (not the browser) over a connection pinned to
 * an address the host guard checked, following at most 5 redirects, each one
 * checked again. Outcomes follow RFC 9309:
 * - 2xx: the rules apply (only the first 512 KiB are parsed);
 * - 4xx, too many redirects, or a redirect off public http(s): no rules (allowed);
 * - 5xx and 429 (Too Many Requests): the whole site is treated as disallowed for a minute;
 * - network failure or more than 10 s in total: a retryable `network_error` (nothing cached).
 */
import http from "node:http";
import https from "node:https";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { createPinnedLookup } from "./egress-proxy.mjs";
import { networkError, permissionDenied } from "./errors.mjs";
import { isPathAllowed, parseRobotsTxt, selectRules } from "./robots.mjs";
import { shortenUrl } from "./url-policy.mjs";

export const ROBOTS_PRODUCT_TOKEN = "graphrt-web-browser";
export const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_ROBOTS_REDIRECTS = 5;
const ROBOTS_TIMEOUT_MS = 8000;
const ROBOTS_TOTAL_TIMEOUT_MS = 10000;
const RULES_CACHE_TTL_MS = 60 * 60 * 1000;
const SERVER_ERROR_CACHE_TTL_MS = 60 * 1000;
const MAX_CACHED_ORIGINS = 100;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Creates a robots.txt checker.
 *
 * @param options - Checker options (object)
 * @param options.hostGuard - From createHostGuard (object)
 * @param options.userAgent - User-Agent header for robots.txt requests (string)
 * @param options.fetchRobotsFile - `async (robotsUrl, {signal}) => {status, text?, reason?}`; defaults to a pinned Node request (function, optional)
 * @param options.now - Clock for the cache (() => number, optional)
 * @returns `{isAllowed(url, {signal}), assertAllowed(url, {signal})}` (object)
 */
export function createRobotsChecker({ hostGuard, userAgent, fetchRobotsFile, now = Date.now }) {
  const fetchFile = fetchRobotsFile ?? ((robotsUrl, options) => fetchRobotsFileWithNode(robotsUrl, { ...options, hostGuard, userAgent }));
  const policyCache = new Map();
  const loadPolicy = async (origin, signal) => {
    const cachedPolicy = policyCache.get(origin);
    if (cachedPolicy && cachedPolicy.expiresAt > now()) return cachedPolicy;
    const fetchedPolicy = buildPolicy(await fetchFile(`${origin}/robots.txt`, { signal }), now());
    policyCache.delete(origin);
    policyCache.set(origin, fetchedPolicy);
    if (policyCache.size > MAX_CACHED_ORIGINS) policyCache.delete(policyCache.keys().next().value);
    return fetchedPolicy;
  };
  const isAllowed = async (url, { signal } = {}) => {
    const parsedUrl = new URL(url);
    const policy = await loadPolicy(parsedUrl.origin, signal);
    if (policy.disallowAll) return false;
    return isPathAllowed(policy.rules, `${parsedUrl.pathname}${parsedUrl.search}`);
  };
  return {
    isAllowed,
    /** Throws `permission_denied` when robots.txt disallows `url` for our product token. */
    async assertAllowed(url, options) {
      if (await isAllowed(url, options)) return;
      throw permissionDenied(
        `robots.txt of ${new URL(url).origin} disallows ${shortenUrl(url)} for ${ROBOTS_PRODUCT_TOKEN} (or for *). Set WEB_BROWSER_RESPECT_ROBOTS=0 to ignore robots.txt.`,
      );
    },
  };
}

function buildPolicy(fetchOutcome, currentTime) {
  if (fetchOutcome.status === "ok") {
    return { rules: selectRules(parseRobotsTxt(fetchOutcome.text), ROBOTS_PRODUCT_TOKEN), disallowAll: false, expiresAt: currentTime + RULES_CACHE_TTL_MS };
  }
  if (fetchOutcome.status === "server_error") return { rules: [], disallowAll: true, expiresAt: currentTime + SERVER_ERROR_CACHE_TTL_MS };
  if (fetchOutcome.status === "unavailable") return { rules: [], disallowAll: false, expiresAt: currentTime + RULES_CACHE_TTL_MS };
  throw networkError(`Fetching robots.txt failed: ${fetchOutcome.reason ?? "unknown error"}`);
}

/**
 * Fetches a robots.txt file over a pinned connection (see module docs).
 *
 * @param robotsUrl - `<origin>/robots.txt` (string)
 * @param options - `{hostGuard, userAgent, signal}` (object)
 * @returns `{status: "ok", text}`, `{status: "unavailable"}`, `{status: "server_error"}` or `{status: "network_error", reason}` (Promise<object>)
 */
export async function fetchRobotsFileWithNode(robotsUrl, { hostGuard, userAgent, signal }) {
  // All hops share one budget, so a slow redirect chain cannot eat the operation's time.
  const totalTimeout = AbortSignal.timeout(ROBOTS_TOTAL_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, totalTimeout]) : totalTimeout;
  let currentUrl = robotsUrl;
  for (let hopCount = 0; hopCount <= MAX_ROBOTS_REDIRECTS; hopCount += 1) {
    const parsedUrl = new URL(currentUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return { status: "unavailable" };
    const addresses = await resolveForRobots(hostGuard, parsedUrl.hostname);
    if (!addresses.ok) return addresses.outcome;
    const response = await requestOnce(parsedUrl, { address: addresses.list[0], userAgent, signal: requestSignal }).catch((requestError) => ({ failure: requestError }));
    if (response.failure) return { status: "network_error", reason: response.failure.message ?? String(response.failure) };
    if (!REDIRECT_STATUSES.has(response.statusCode)) return classifyRobotsResponse(response);
    if (!response.location) return { status: "unavailable" };
    currentUrl = new URL(response.location, currentUrl).href;
  }
  return { status: "unavailable" };
}

async function resolveForRobots(hostGuard, hostname) {
  try {
    return { ok: true, list: await hostGuard.resolvePublicAddresses(hostname) };
  } catch (guardError) {
    // A robots.txt redirect to an internal host is never followed; treat the file as missing.
    if (guardError instanceof PluginError && guardError.kind === "permission_denied") return { ok: false, outcome: { status: "unavailable" } };
    return { ok: false, outcome: { status: "network_error", reason: guardError.message } };
  }
}

function classifyRobotsResponse(response) {
  if (response.statusCode >= 200 && response.statusCode < 300) return { status: "ok", text: response.text };
  if (response.statusCode >= 500 || response.statusCode === 429) return { status: "server_error" };
  return { status: "unavailable" };
}

function requestOnce(parsedUrl, { address, userAgent, signal }) {
  const transport = parsedUrl.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(parsedUrl, {
      headers: { "user-agent": userAgent, accept: "text/plain,*/*;q=0.5" },
      lookup: createPinnedLookup(address),
      agent: false,
      timeout: ROBOTS_TIMEOUT_MS,
      signal,
    });
    request.on("timeout", () => request.destroy(new Error(`timed out after ${ROBOTS_TIMEOUT_MS / 1000} s`)));
    request.on("error", reject);
    request.on("response", (response) => readCappedBody(response).then(resolve, reject));
  });
}

// Keeps only the first MAX_ROBOTS_BYTES; the rest of the file is ignored (RFC 9309 allows this).
function readCappedBody(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteCount = 0;
    const finish = () => resolve({ statusCode: response.statusCode, location: response.headers.location, text: Buffer.concat(chunks).toString("utf8") });
    response.on("data", (chunk) => {
      chunks.push(chunk.subarray(0, Math.max(0, MAX_ROBOTS_BYTES - byteCount)));
      byteCount += chunk.length;
      if (byteCount >= MAX_ROBOTS_BYTES) {
        response.destroy();
        finish();
      }
    });
    response.on("end", finish);
    response.on("error", (readError) => (byteCount >= MAX_ROBOTS_BYTES ? finish() : reject(readError)));
  });
}
