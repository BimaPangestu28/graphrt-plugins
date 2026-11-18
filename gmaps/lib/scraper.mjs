/**
 * Google Maps scraper built on Playwright (Chromium).
 *
 * Flow: open the search URL → accept the consent screen if shown → either read
 * the single place Google jumped to, or scroll the result feed, collect place
 * links and visit each one to read its details.
 *
 * Selectors follow the Maps UI as of late 2026 and will need updating when
 * Google changes it. Logs go to stderr only (stdout carries the plugin protocol).
 */
import { chromium } from "playwright";
import { PluginError } from "../graphrt-plugin.mjs";
import { bindAbortToBrowser, toCancelledIfAborted } from "./cancellation.mjs";
import { buildSearchUrl, classifyLaunchError, extractPlaceDetails, isBlockedPage, parseRating } from "./parse.mjs";

const NAVIGATION_TIMEOUT_MS = 30000;
const PLACE_READY_TIMEOUT_MS = 10000;
const SCROLL_PAUSE_MS = 1200;
const MAX_IDLE_SCROLLS = 3;
const FEED_SELECTOR = 'div[role="feed"]';
const PLACE_LINK_SELECTOR = 'a[href*="/maps/place/"]';
const CONSENT_BUTTON_SELECTOR = [
  'button:has-text("Accept all")',
  'button:has-text("Terima semua")',
  'form[action*="consent"] button[aria-label*="Accept" i]',
].join(", ");

/**
 * Searches Google Maps and returns details for up to `maxResults` places.
 *
 * @param options - Validated search options (see validateSearchConfig)
 * @param options.query - Search text (string)
 * @param options.maxResults - Maximum places to return (number)
 * @param options.language - Interface language code (string)
 * @param options.headless - Run the browser without a window (boolean)
 * @param hooks - Optional runtime hooks
 * @param hooks.signal - Cancels the search when aborted (AbortSignal)
 * @param hooks.onProgress - Called after each place with `{index, total, name}`
 * @returns Places as `{name, phone, address, website, rating, maps_url}` (Promise<Array<object>>)
 * @throws PluginError kinds `blocked`, `setup_required`, `browser_error`, `cancelled`
 */
export async function searchPlaces(options, hooks = {}) {
  throwIfCancelled(hooks.signal);
  const browser = await launchBrowser(options.headless);
  const unbindAbort = bindAbortToBrowser(hooks.signal, browser);
  try {
    return await runSearchInBrowser(browser, options, hooks);
  } catch (searchError) {
    throw toCancelledIfAborted(searchError, hooks.signal);
  } finally {
    unbindAbort();
    await browser.close().catch((closeError) => console.error(`[gmaps] browser close failed: ${closeError.message}`));
  }
}

async function runSearchInBrowser(browser, options, hooks) {
  const context = await browser.newContext({ locale: options.language });
  const page = await context.newPage();
  page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
  await openSearch(page, options);
  if (!(await page.$(FEED_SELECTOR))) {
    return readSinglePlace(page, hooks);
  }
  const placeUrls = await collectPlaceUrls(page, options.maxResults, hooks.signal);
  return readPlaces(page, placeUrls, hooks);
}

async function launchBrowser(headless) {
  try {
    return await chromium.launch({ headless });
  } catch (launchError) {
    throw classifyLaunchError(launchError);
  }
}

async function openSearch(page, options) {
  await page.goto(buildSearchUrl(options.query, options.language), { waitUntil: "domcontentloaded" });
  await acceptConsentIfShown(page);
  await assertNotBlocked(page);
  // Either the result feed or a single place header appears once Maps has rendered.
  await page.waitForSelector(`${FEED_SELECTOR}, h1`, { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
  await assertNotBlocked(page);
}

async function acceptConsentIfShown(page) {
  if (!page.url().includes("consent.google.")) return;
  const consentButton = await page.$(CONSENT_BUTTON_SELECTOR);
  if (!consentButton) return;
  await Promise.all([page.waitForURL(/google\.[^/]+\/maps/, { timeout: NAVIGATION_TIMEOUT_MS }), consentButton.click()]);
}

async function assertNotBlocked(page) {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (isBlockedPage(page.url(), bodyText)) {
    throw new PluginError("Google Maps is showing a CAPTCHA / unusual traffic page. Try again later or with fewer results.", {
      kind: "blocked",
      retryable: true,
      retryAfterMs: 600000,
    });
  }
}

async function collectPlaceUrls(page, maxResults, signal) {
  let placeUrls = [];
  let idleScrolls = 0;
  while (placeUrls.length < maxResults && idleScrolls < MAX_IDLE_SCROLLS) {
    throwIfCancelled(signal);
    const previousCount = placeUrls.length;
    placeUrls = await readFeedLinks(page);
    idleScrolls = placeUrls.length > previousCount ? 0 : idleScrolls + 1;
    if (placeUrls.length >= maxResults || (await isFeedExhausted(page))) break;
    await page.$eval(FEED_SELECTOR, (feed) => feed.scrollBy(0, feed.scrollHeight));
    await page.waitForTimeout(SCROLL_PAUSE_MS);
  }
  return placeUrls.slice(0, maxResults);
}

async function readFeedLinks(page) {
  const hrefs = await page.$$eval(`${FEED_SELECTOR} ${PLACE_LINK_SELECTOR}`, (anchors) => anchors.map((anchor) => anchor.href));
  return [...new Set(hrefs)];
}

async function isFeedExhausted(page) {
  // Maps renders a "You've reached the end of the list." marker in the feed.
  return page.$eval(FEED_SELECTOR, (feed) => Boolean(feed.querySelector("span.HlvSq"))).catch(() => false);
}

async function readPlaces(page, placeUrls, hooks) {
  const placeResults = [];
  for (const [index, placeUrl] of placeUrls.entries()) {
    throwIfCancelled(hooks.signal);
    const placeResult = await readPlaceAt(page, placeUrl, hooks.signal);
    if (placeResult) placeResults.push(placeResult);
    hooks.onProgress?.({ index: index + 1, total: placeUrls.length, name: placeResult?.name ?? null });
  }
  return placeResults;
}

async function readPlaceAt(page, placeUrl, signal) {
  try {
    await page.goto(placeUrl, { waitUntil: "domcontentloaded" });
    await assertNotBlocked(page);
    return await readPlaceDetails(page);
  } catch (placeError) {
    // A closed browser after cancel must abort the search, not skip one place.
    if (placeError instanceof PluginError || signal?.aborted) throw placeError;
    console.error(`[gmaps] skipping place ${placeUrl}: ${placeError.message}`);
    return null;
  }
}

async function readSinglePlace(page, hooks) {
  const placeResult = await readPlaceDetails(page).catch((placeError) => {
    if (hooks.signal?.aborted) throw placeError;
    console.error(`[gmaps] no place found on ${page.url()}: ${placeError.message}`);
    return null;
  });
  if (!placeResult) return [];
  hooks.onProgress?.({ index: 1, total: 1, name: placeResult.name });
  return [placeResult];
}

async function readPlaceDetails(page) {
  await page.waitForSelector("h1", { timeout: PLACE_READY_TIMEOUT_MS });
  // Detail buttons render a moment after the header.
  await page.waitForSelector("[data-item-id]", { timeout: PLACE_READY_TIMEOUT_MS }).catch(() => {});
  const name = (await page.locator("h1").first().innerText()).trim();
  const ratingText = await page
    .locator('div.F7nice span[aria-hidden="true"]')
    .first()
    .innerText({ timeout: 2000 })
    .catch(() => null);
  const placeItems = await page.$$eval("[data-item-id]", (elements) =>
    elements.map((element) => ({
      itemId: element.getAttribute("data-item-id") ?? "",
      label: element.getAttribute("aria-label") ?? element.innerText ?? "",
    })),
  );
  return { name, ...extractPlaceDetails(placeItems), rating: parseRating(ratingText), maps_url: page.url() };
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new PluginError("Search cancelled", { kind: "cancelled" });
}
