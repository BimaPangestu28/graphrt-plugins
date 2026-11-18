/**
 * Waits for a Google Maps search page to settle into a recognisable state.
 *
 * One probe reads everything at once (feed, place marker, CAPTCHA element, text)
 * and the pure `classifySearchOutcome` decides. This avoids the old race where
 * any `h1` (e.g. the result list's "Results" heading) was taken as a single
 * place before the feed rendered. Free of Playwright imports so it can be
 * unit-tested with a fake page.
 */
import { PluginError } from "../graphrt-plugin.mjs";
import { classifySearchOutcome } from "./parse.mjs";

export const FEED_SELECTOR = 'div[role="feed"]';
// Elements that only exist on a place's detail panel (the place title and its detail items).
export const PLACE_MARKER_SELECTOR = 'h1.DUwDvf, [data-item-id="address"], [data-item-id^="phone:tel:"]';
export const CAPTCHA_SELECTOR = 'form#captcha-form, iframe[src*="recaptcha"], div.g-recaptcha';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_POLL_MS = 250;

/**
 * Polls the page until it shows results, a single place, a no-results notice or a CAPTCHA.
 *
 * @param page - Playwright Page (or a fake with `url()` and `evaluate()`)
 * @param options - Timing and cancellation
 * @param options.timeoutMs - Give up after this long (number, default 30000)
 * @param options.pollMs - Delay between probes (number, default 250)
 * @param options.signal - Aborts the wait (AbortSignal)
 * @returns `"results" | "single_place" | "no_results" | "blocked" | "timeout"` (Promise<string>)
 * @throws PluginError kind `cancelled` - When the signal aborts
 */
export async function waitForSearchOutcome(page, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS, signal } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new PluginError("Search cancelled", { kind: "cancelled" });
    const searchProbe = await probeSearchPage(page);
    const outcome = searchProbe ? classifySearchOutcome(searchProbe) : null;
    if (outcome) return outcome;
    if (Date.now() >= deadline) return "timeout";
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Reads the page state used by `classifySearchOutcome` in a single round trip.
 *
 * @param page - Playwright Page
 * @returns `{pageUrl, hasFeed, hasPlaceMarker, hasCaptcha, bodyText}`, or null while
 *   the page is mid-navigation (Promise<object | null>)
 */
export async function probeSearchPage(page) {
  const selectors = { feed: FEED_SELECTOR, placeMarker: PLACE_MARKER_SELECTOR, captcha: CAPTCHA_SELECTOR };
  const pageUrl = page.url();
  try {
    const pageState = await page.evaluate(
      (probeSelectors) => ({
        hasFeed: Boolean(document.querySelector(probeSelectors.feed)),
        hasPlaceMarker: Boolean(document.querySelector(probeSelectors.placeMarker)),
        hasCaptcha: Boolean(document.querySelector(probeSelectors.captcha)),
        bodyText: document.body?.innerText ?? "",
      }),
      selectors,
    );
    return { pageUrl, ...pageState };
  } catch {
    // "Execution context was destroyed" during a redirect: not decided yet.
    return null;
  }
}
