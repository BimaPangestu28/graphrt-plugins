/**
 * Opens one URL in a fresh, locked-down browser context and hands the loaded
 * page to a reader. Order of checks for every operation:
 *
 * 1. the URL is http(s) without credentials (url-policy.mjs);
 * 2. its host resolves only to public addresses (address-policy.mjs);
 * 3. robots.txt allows it, when WEB_BROWSER_RESPECT_ROBOTS is on;
 * 4. inside the browser, every request passes `context.route` (request-guard.mjs)
 *    and the per-operation egress proxy (egress-proxy.mjs), which also covers
 *    redirect hops and caps the bytes downloaded;
 * 5. after loading, the main-frame chain is checked again (blocked redirect,
 *    robots.txt disallow on a redirect target, non-http final URL).
 *
 * Contexts never accept downloads, block service workers, keep nothing between
 * operations, and run page-hardening.mjs in every page, frame and worker
 * (no WebRTC, WebSocket, WebSocketStream or WebTransport).
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { BLOCKED_HEADER } from "./egress-proxy.mjs";
import { invalidInput, networkError, notFound, permissionDenied, runStep, timeoutError } from "./errors.mjs";
import { buildHardeningArgument, hardenScopeInPage } from "./page-hardening.mjs";
import { createRequestGuard, isMainFrameNavigation } from "./request-guard.mjs";
import { hostnameOf, isHttpUrl, parseNavigableUrl, shortenUrl } from "./url-policy.mjs";

/** Extra time on top of `timeout_seconds` for browser start, reading the page and screenshots. */
export const READ_ALLOWANCE_MS = 25000;
export const MAX_REQUESTS_PER_PAGE = 500;
const TEXT_SKIPPED_RESOURCE_TYPES = ["image", "media", "font"];
const MAX_REPORTED_BLOCKS = 20;
// Chromium skips the proxy for loopback hosts unless told otherwise; never rely on Playwright's default.
export const PROXY_BYPASS_RULES = "<-loopback>";

/**
 * Loads a page under all safety checks and runs `readPage` on it.
 *
 * @param client - From createClientFactory: `{settings, session, hostGuard, robotsChecker, startProxy, resolveUserAgent}` (object)
 * @param request - Load options (object)
 * @param request.url - URL to open (string)
 * @param request.waitUntil - "load" | "domcontentloaded" | "networkidle" (string)
 * @param request.waitForSelector - CSS selector to wait for, or null (string | null)
 * @param request.timeoutMs - Navigation + wait budget (number)
 * @param request.purpose - "text" (images, media and fonts skipped) or "screenshot" (string)
 * @param request.viewport - `{width, height}` (object, optional)
 * @param readPage - `async (page, loadedPage) => result`; `loadedPage` is `{finalUrl, status, contentType, warnings}` (function)
 * @param signal - Caller cancel/deadline signal (AbortSignal, optional)
 * @returns `{result, loadedPage, blockedRequests}` (Promise<object>)
 * @throws PluginError kinds `invalid_input`, `permission_denied`, `not_found`, `network_error`, `timeout`, `cancelled`, `browser_error`, `setup_required`
 */
export async function browsePage(client, request, readPage, signal) {
  const target = parseNavigableUrl(request.url);
  const operationSignal = combineSignals(signal, AbortSignal.timeout(request.timeoutMs + READ_ALLOWANCE_MS));
  await client.hostGuard.assertPublicHost(target.hostname, { signal: operationSignal });
  if (client.robotsChecker) await client.robotsChecker.assertAllowed(target.href, { signal: operationSignal });
  const proxy = await client.startProxy({ hostGuard: client.hostGuard, maxResponseBytes: client.settings.maxDownloadBytes });
  try {
    const contextOptions = buildContextOptions({ proxy, userAgent: await client.resolveUserAgent(), viewport: request.viewport });
    const guard = createRequestGuard({
      hostGuard: client.hostGuard,
      robotsChecker: client.robotsChecker,
      skippedResourceTypes: request.purpose === "screenshot" ? [] : TEXT_SKIPPED_RESOURCE_TYPES,
      maxRequests: MAX_REQUESTS_PER_PAGE,
      navigationTimeoutMs: request.timeoutMs,
    });
    const loadContext = { target, request, guard, proxy, readPage };
    return await client.session.withContext(contextOptions, (context) => loadAndRead(context, loadContext), { signal: operationSignal });
  } finally {
    await proxy.close();
  }
}

/**
 * Browser context options for one operation (no downloads, no service workers, no state).
 * Every connection, loopback included, goes through the operation's proxy with its credentials.
 *
 * @param options - `{proxy: {url, credentials: {username, password}}, userAgent, viewport}` (object)
 * @returns Playwright `newContext` options (object)
 */
export function buildContextOptions({ proxy, userAgent, viewport }) {
  return {
    proxy: { server: proxy.url, bypass: PROXY_BYPASS_RULES, username: proxy.credentials.username, password: proxy.credentials.password },
    acceptDownloads: false,
    serviceWorkers: "block",
    javaScriptEnabled: true,
    ignoreHTTPSErrors: false,
    bypassCSP: false,
    permissions: [],
    locale: "en-US",
    userAgent,
    viewport: viewport ?? { width: 1280, height: 800 },
  };
}

async function loadAndRead(context, { target, request, guard, proxy, readPage }) {
  await context.addInitScript(hardenScopeInPage, buildHardeningArgument());
  await context.route("**/*", guard.handleRoute);
  const page = await context.newPage();
  guard.watchPage(page);
  const mainResponses = trackMainFrameResponses(page);
  const startedAt = Date.now();
  const warnings = await navigate(page, target.href, { request, guard, proxy, mainResponses });
  assertLoadAllowed({ page, guard, proxy, mainResponse: mainResponses.last() });
  if (request.waitForSelector) await waitForSelector(page, request.waitForSelector, request.timeoutMs - (Date.now() - startedAt));
  if (proxy.stats().budgetExceeded) warnings.push("The download cap was reached; the page may be incomplete");
  const loadedPage = describeLoadedPage(page, mainResponses.last(), warnings);
  const result = await readLoadedPage({ page, loadedPage, readPage, guard, proxy });
  assertLoadAllowed({ page, guard, proxy, mainResponse: mainResponses.last() });
  return { result, loadedPage, blockedRequests: mergeBlockedRequests(guard.report().blocked, proxy.stats().blocked) };
}

// A navigation that starts while the page is read (meta refresh, script) can break the read;
// when the guards refused that navigation, the refusal is the error to report.
async function readLoadedPage({ page, loadedPage, readPage, guard, proxy }) {
  try {
    return await runStep("read page", () => readPage(page, loadedPage));
  } catch (readError) {
    throw findSecurityViolation(guard, proxy) ?? readError;
  }
}

function trackMainFrameResponses(page) {
  let lastResponse = null;
  page.on("response", (response) => {
    if (isMainFrameNavigation(response.request())) lastResponse = response;
  });
  return { last: () => lastResponse };
}

async function navigate(page, url, { request, guard, proxy, mainResponses }) {
  const warnings = [];
  try {
    await page.goto(url, { waitUntil: request.waitUntil, timeout: request.timeoutMs });
  } catch (navigationError) {
    const isSoftTimeout = isTimeoutError(navigationError) && mainResponses.last() && isHttpUrl(page.url());
    if (!isSoftTimeout) throw classifyNavigationError(navigationError, { guard, proxy, url });
    warnings.push(`The page did not reach \`${request.waitUntil}\` within ${Math.round(request.timeoutMs / 1000)} s; returning what had loaded`);
  }
  return warnings;
}

/**
 * Maps a failed `page.goto` to a plugin error, preferring what the guards recorded.
 *
 * @param navigationError - Error from Playwright (Error)
 * @param options - `{guard, proxy, url}` (object)
 * @returns PluginError
 */
export function classifyNavigationError(navigationError, { guard, proxy, url }) {
  if (navigationError instanceof PluginError) return navigationError;
  const securityError = findSecurityViolation(guard, proxy);
  if (securityError) return securityError;
  const message = String(navigationError?.message ?? navigationError);
  if (/Download is starting/i.test(message)) return invalidInput(`${shortenUrl(url)} starts a file download; downloads are disabled`);
  if (proxy.stats().budgetExceeded) return invalidInput(`${shortenUrl(url)} exceeded the download cap (WEB_BROWSER_MAX_DOWNLOAD_MB)`);
  if (/ERR_NAME_NOT_RESOLVED/.test(message)) return notFound(`Host of ${shortenUrl(url)} does not resolve`);
  if (isTimeoutError(navigationError)) return timeoutError(`${shortenUrl(url)} did not load in time`);
  const networkCode = /net::(ERR_[A-Z_]+)/.exec(message)?.[1];
  if (networkCode) return networkError(`Loading ${shortenUrl(url)} failed: ${networkCode}`);
  return new PluginError(`Loading ${shortenUrl(url)} failed: ${message.split("\n")[0]}`, { kind: "browser_error" });
}

function assertLoadAllowed({ page, guard, proxy, mainResponse }) {
  const securityError = findSecurityViolation(guard, proxy);
  if (securityError) throw securityError;
  if (mainResponse?.headers?.()[BLOCKED_HEADER]) throw permissionDenied(`The page was blocked by the network guard: ${describeBlocks(proxy.stats().blocked)}`);
  if (!isHttpUrl(page.url())) throw permissionDenied(`The page ended on a non-http(s) URL (${shortenUrl(page.url(), 80)}); only http(s) pages are read`);
}

function findSecurityViolation(guard, proxy) {
  const guardReport = guard.report();
  const violation = guardReport.navigationViolation;
  if (violation?.kind === "robots") {
    return permissionDenied(`The page led to ${shortenUrl(violation.url)}, which robots.txt refuses (${violation.reason}). Set WEB_BROWSER_RESPECT_ROBOTS=0 to ignore robots.txt.`);
  }
  if (violation) return permissionDenied(`The page led to ${shortenUrl(violation.url)}, which is refused: ${violation.reason}`);
  const blockedHosts = proxy.stats().blockedHosts;
  const blockedHop = guardReport.navigationUrls.find((navigationUrl) => blockedHosts.has(hostnameOf(navigationUrl)));
  if (blockedHop) return permissionDenied(`The page redirected to ${shortenUrl(blockedHop)}, an internal host; web-browser only visits public hosts`);
  return null;
}

async function waitForSelector(page, selector, remainingMs) {
  try {
    await page.waitForSelector(`css=${selector}`, { state: "attached", timeout: Math.max(1000, remainingMs) });
  } catch (waitError) {
    const message = String(waitError?.message ?? waitError);
    if (isTimeoutError(waitError)) throw timeoutError(`\`wait_for_selector\` ${JSON.stringify(selector)} did not appear in time`);
    if (/selector|Unexpected token|parse/i.test(message)) throw invalidInput(`\`wait_for_selector\` is not a valid CSS selector: ${message.split("\n")[0]}`);
    throw waitError;
  }
}

function describeLoadedPage(page, mainResponse, warnings) {
  return {
    finalUrl: page.url(),
    status: mainResponse?.status?.() ?? null,
    contentType: mainResponse?.headers?.()["content-type"] ?? null,
    warnings,
  };
}

function mergeBlockedRequests(guardBlocks, proxyBlocks) {
  const seenTargets = new Set();
  const merged = [];
  for (const block of [...guardBlocks, ...proxyBlocks]) {
    if (seenTargets.has(block.target) || merged.length >= MAX_REPORTED_BLOCKS) continue;
    seenTargets.add(block.target);
    merged.push(block);
  }
  return merged;
}

function describeBlocks(blocks) {
  return blocks.length > 0 ? blocks.map((block) => `${block.target}: ${block.reason}`).join("; ") : "blocked";
}

function isTimeoutError(candidateError) {
  return candidateError?.name === "TimeoutError" || /Timeout \d+ms exceeded/i.test(String(candidateError?.message ?? ""));
}

function combineSignals(callerSignal, timeoutSignal) {
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}
