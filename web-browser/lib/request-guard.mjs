/**
 * Per-context request interception (`context.route`), the first of two
 * network checks (the egress proxy is the second, see egress-proxy.mjs):
 *
 * - every request must be http(s) to a public host, or it is aborted;
 * - images, media and fonts are skipped for text operations (fewer bytes);
 * - a request cap stops pages that fire endless requests;
 * - main-frame navigations are checked against robots.txt.
 *
 * Redirects: Playwright never calls route handlers for redirect hops. So a
 * main-frame GET navigation is fetched here hop by hop (`route.fetch` with
 * `maxRedirects: 0`, through the same egress proxy) and every hop's host and
 * robots.txt are checked BEFORE it is requested. When the chain ends somewhere
 * else, the browser is sent there with a 302 (that last request is not routed
 * again, but its host is checked by the proxy and its robots.txt was checked
 * here). `watchPage` remains a backstop for redirects the browser follows
 * itself (e.g. a server answering the final request with yet another redirect).
 */
import { hostnameOf, isHttpUrl, shortenUrl } from "./url-policy.mjs";

const MAX_RECORDED_BLOCKS = 50;
export const MAX_NAVIGATION_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Creates a request guard for one browser context.
 *
 * @param options - Guard options (object)
 * @param options.hostGuard - From createHostGuard (object)
 * @param options.robotsChecker - From createRobotsChecker, or null when robots.txt is ignored (object | null)
 * @param options.skippedResourceTypes - Playwright resource types to abort quietly, e.g. ["image"] (string[])
 * @param options.maxRequests - Requests allowed per page load (number)
 * @param options.navigationTimeoutMs - Timeout for each hop fetched by the guard (number)
 * @returns `{handleRoute(route), watchPage(page), report()}` (object)
 */
export function createRequestGuard({ hostGuard, robotsChecker, skippedResourceTypes = [], maxRequests, navigationTimeoutMs = 30000 }) {
  const skippedTypes = new Set(skippedResourceTypes);
  const state = { requestCount: 0, blocked: [], navigationViolation: null, navigationUrls: [] };
  const checks = { hostGuard, robotsChecker, state, navigationTimeoutMs };
  const handleRoute = async (route) => {
    const request = route.request();
    const url = request.url();
    state.requestCount += 1;
    if (state.requestCount > maxRequests) return blockRoute(route, state, url, `more than ${maxRequests} requests for one page`);
    if (!isHttpUrl(url)) return blockRoute(route, state, url, "only http(s) requests are allowed");
    if (skippedTypes.has(request.resourceType())) return settleRoute(() => route.abort("blockedbyclient"));
    if (!isMainFrameNavigation(request)) {
      const hostVerdict = await checkHost(hostGuard, url);
      return hostVerdict.allowed ? settleRoute(() => route.continue()) : blockRoute(route, state, url, hostVerdict.reason);
    }
    const verdict = await checkNavigationTarget(checks, url);
    if (!verdict.allowed) return blockNavigation(route, state, url, verdict);
    return request.method() === "GET" ? followRedirectsSafely(route, checks) : settleRoute(() => route.continue());
  };
  return {
    handleRoute,
    watchPage: (page) => watchMainFrameNavigations(page, checks),
    /** `{requestCount, blocked: [{target, reason}], navigationViolation: {url, reason, kind} | null, navigationUrls}` */
    report: () => ({ ...state, blocked: [...state.blocked], navigationUrls: [...state.navigationUrls] }),
  };
}

// Fetches the navigation hop by hop, checking each redirect target before requesting it.
async function followRedirectsSafely(route, checks) {
  let hopUrl = route.request().url();
  for (let hopCount = 0; hopCount <= MAX_NAVIGATION_REDIRECTS; hopCount += 1) {
    const response = await fetchHop(route, hopUrl, checks.navigationTimeoutMs);
    if (!response) return settleRoute(() => route.abort("failed"));
    const location = REDIRECT_STATUSES.has(response.status()) ? response.headers().location : null;
    if (!location) {
      if (hopCount === 0) return settleRoute(() => route.fulfill({ response }));
      return settleRoute(() => route.fulfill({ status: 302, headers: { location: hopUrl } }));
    }
    hopUrl = resolveLocation(location, hopUrl);
    const verdict = hopUrl ? await checkNavigationTarget(checks, hopUrl) : { allowed: false, kind: "host", reason: "redirect to a non-http(s) URL" };
    if (!verdict.allowed) return blockNavigation(route, checks.state, hopUrl ?? location, verdict);
  }
  return blockRoute(route, checks.state, hopUrl, `more than ${MAX_NAVIGATION_REDIRECTS} redirects`);
}

async function fetchHop(route, hopUrl, timeoutMs) {
  try {
    return await route.fetch({ url: hopUrl, maxRedirects: 0, timeout: timeoutMs });
  } catch (fetchError) {
    console.error(`[web-browser] fetching ${shortenUrl(hopUrl)} failed: ${String(fetchError?.message ?? fetchError).split("\n")[0]}`);
    return null;
  }
}

function resolveLocation(location, baseUrl) {
  try {
    const resolvedUrl = new URL(location, baseUrl).href;
    return isHttpUrl(resolvedUrl) ? resolvedUrl : null;
  } catch {
    return null;
  }
}

function watchMainFrameNavigations(page, checks) {
  page.on("request", (request) => {
    if (!isMainFrameNavigation(request)) return;
    checks.state.navigationUrls.push(request.url());
    if (!request.redirectedFrom()) return;
    checkNavigationTarget(checks, request.url()).then((verdict) => {
      if (verdict.allowed) return;
      checks.state.navigationViolation ??= { url: request.url(), reason: verdict.reason, kind: verdict.kind };
      page.close().catch(() => {});
    });
  });
}

/**
 * Tells whether a Playwright request is a navigation of the top-level frame.
 *
 * @param request - Playwright Request (object)
 * @returns true for main-frame navigations (boolean)
 */
export function isMainFrameNavigation(request) {
  try {
    return request.isNavigationRequest() && !request.frame().parentFrame();
  } catch {
    // Service worker requests have no frame (service workers are blocked anyway).
    return false;
  }
}

async function checkNavigationTarget({ hostGuard, robotsChecker }, url) {
  const hostVerdict = await checkHost(hostGuard, url);
  if (!hostVerdict.allowed) return { ...hostVerdict, kind: "host" };
  if (!robotsChecker) return { allowed: true };
  try {
    return (await robotsChecker.isAllowed(url)) ? { allowed: true } : { allowed: false, kind: "robots", reason: "disallowed by robots.txt" };
  } catch (robotsError) {
    return { allowed: false, kind: "robots", reason: `robots.txt check failed: ${robotsError.message ?? robotsError}` };
  }
}

async function checkHost(hostGuard, url) {
  const hostname = hostnameOf(url);
  if (!hostname) return { allowed: false, reason: "the URL has no host" };
  try {
    await hostGuard.assertPublicHost(hostname);
    return { allowed: true };
  } catch (hostError) {
    return { allowed: false, reason: hostError.message ?? String(hostError) };
  }
}

function blockNavigation(route, state, url, verdict) {
  state.navigationViolation ??= { url, reason: verdict.reason, kind: verdict.kind };
  return blockRoute(route, state, url, verdict.reason);
}

function blockRoute(route, state, url, reason) {
  if (state.blocked.length < MAX_RECORDED_BLOCKS) state.blocked.push({ target: shortenUrl(url), reason });
  return settleRoute(() => route.abort("blockedbyclient"));
}

// The page may close (cancel, deadline) while a handler is still deciding; that is not an error.
async function settleRoute(settle) {
  try {
    await settle();
  } catch {
    // Route already handled or page closed.
  }
}
