/**
 * Pure helpers for the google-maps-scraper plugin: config validation, URL building and
 * parsing of values scraped from a Google Maps place page.
 *
 * Kept free of Playwright so every rule here is unit-testable.
 */
import { PluginError } from "../graphrt-plugin.mjs";

export const DEFAULT_MAX_RESULTS = 20;
export const MAX_RESULTS_LIMIT = 100;
export const DEFAULT_LANGUAGE = "id";

// BCP-47-ish language tag (e.g. "id", "en", "pt-BR"). Rejecting anything else
// keeps user input from injecting extra query parameters into the Maps URL.
const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

const ADDRESS_PREFIX = /^(alamat|address)\s*:\s*/i;
const WEBSITE_PREFIX = /^(situs web|website)\s*:\s*/i;
const PHONE_ITEM_PREFIX = "phone:tel:";
// Notices Maps shows in the side panel when a search matches nothing.
const NO_RESULTS_PATTERN = /Google Maps (can't|cannot|can’t) find|Google Maps tidak dapat menemukan/i;

/**
 * Validates node/tool config and applies defaults.
 *
 * @param config - Raw config from the host, templates already resolved (object)
 * @returns Normalized search options ({query, maxResults, language, headless})
 * @throws PluginError kind `invalid_input` - When a field is missing or out of range
 *
 * @example
 * validateSearchConfig({ query: "cafe" });
 * // { query: "cafe", maxResults: 20, language: "id", headless: true }
 */
export function validateSearchConfig(config) {
  const { query, max_results: rawMaxResults = DEFAULT_MAX_RESULTS, language = DEFAULT_LANGUAGE, headless = true } =
    config ?? {};
  const maxResults = parseWholeNumber(rawMaxResults);

  if (typeof query !== "string" || query.trim() === "") {
    throw invalidInput("`query` must be a non-empty string");
  }
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS_LIMIT) {
    throw invalidInput(`\`max_results\` must be an integer between 1 and ${MAX_RESULTS_LIMIT}`);
  }
  if (typeof language !== "string" || !LANGUAGE_PATTERN.test(language)) {
    throw invalidInput("`language` must be a language code such as `id` or `en`");
  }
  if (typeof headless !== "boolean") {
    throw invalidInput("`headless` must be a boolean");
  }
  return { query: query.trim(), maxResults, language, headless };
}

/**
 * Builds the Google Maps search URL for a query.
 *
 * @param query - Search text (string)
 * @param language - Interface language code (string)
 * @returns Absolute Maps search URL (string)
 */
export function buildSearchUrl(query, language) {
  return `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=${encodeURIComponent(language)}`;
}

/**
 * Normalizes a phone number: drops a `tel:` prefix and separators, keeps a leading `+`.
 *
 * @param rawPhone - Phone as found on the page (string | null | undefined)
 * @returns Digits with optional leading `+`, or null when nothing remains
 */
export function normalizePhone(rawPhone) {
  if (typeof rawPhone !== "string") return null;
  const withoutPrefix = rawPhone.trim().replace(/^tel:/i, "");
  const hasPlus = withoutPrefix.startsWith("+");
  const digits = withoutPrefix.replace(/\D/g, "");
  if (digits === "") return null;
  return hasPlus ? `+${digits}` : digits;
}

/**
 * Extracts phone, address and website from a place page's `[data-item-id]` items.
 *
 * The website is the authority anchor's full `href` when it is http(s) (a Google
 * `/url?q=` redirect is unwrapped); otherwise the visible label. The label is
 * always kept as `website_label`.
 *
 * @param placeItems - Items as `{itemId, label, href?}` (Array<object>)
 * @returns `{phone, address, website, website_label}`, each null when absent
 */
export function extractPlaceDetails(placeItems) {
  const placeDetails = { phone: null, address: null, website: null, website_label: null };
  for (const { itemId = "", label = "", href = null } of placeItems ?? []) {
    if (itemId.startsWith(PHONE_ITEM_PREFIX) && placeDetails.phone === null) {
      placeDetails.phone = normalizePhone(itemId.slice(PHONE_ITEM_PREFIX.length)) ?? normalizePhone(label);
    } else if (itemId === "address" && placeDetails.address === null) {
      placeDetails.address = cleanLabel(label, ADDRESS_PREFIX);
    } else if (itemId === "authority" && placeDetails.website === null) {
      placeDetails.website_label = cleanLabel(label, WEBSITE_PREFIX);
      placeDetails.website = normalizeWebsiteHref(href) ?? placeDetails.website_label;
    }
  }
  return placeDetails;
}

/**
 * Parses a rating such as "4,5" or "4.7".
 *
 * @param ratingText - Rating text (string | null)
 * @returns Rating number, or null when unparseable
 */
export function parseRating(ratingText) {
  if (typeof ratingText !== "string") return null;
  const rating = Number.parseFloat(ratingText.trim().replace(",", "."));
  return Number.isFinite(rating) ? rating : null;
}

/**
 * Collects unique, non-null phones from results, preserving order.
 *
 * @param placeResults - Results with a `phone` field (Array<object>)
 * @returns Phone numbers (string[])
 */
export function collectPhones(placeResults) {
  const phones = placeResults.map((placeResult) => placeResult.phone).filter((phone) => phone);
  return [...new Set(phones)];
}

/**
 * Detects Google's anti-bot interstitial.
 *
 * Only the `/sorry/` URL or a real CAPTCHA element count: the phrase "unusual
 * traffic" can appear in ordinary page text (reviews, place names).
 *
 * @param pageUrl - Current page URL (string)
 * @param hasCaptchaElement - Whether a CAPTCHA form / reCAPTCHA iframe is on the page (boolean)
 * @returns True when Google is asking for a CAPTCHA (boolean)
 */
export function isBlockedPage(pageUrl, hasCaptchaElement) {
  return String(pageUrl).includes("/sorry/") || hasCaptchaElement === true;
}

/**
 * Tells whether a URL is a single-place page (Maps jumped straight to one place).
 *
 * @param pageUrl - Current page URL (string)
 * @returns True for `/maps/place/` URLs (boolean)
 */
export function isSinglePlaceUrl(pageUrl) {
  try {
    return new URL(pageUrl).pathname.includes("/maps/place/");
  } catch {
    return false;
  }
}

/**
 * Tells whether page text contains Maps' "no results" notice.
 *
 * @param bodyText - Visible page text (string)
 * @returns True when the search matched nothing (boolean)
 */
export function isNoResultsText(bodyText) {
  return NO_RESULTS_PATTERN.test(bodyText ?? "");
}

/**
 * Decides what a freshly loaded search page shows.
 *
 * @param searchProbe - `{pageUrl, hasFeed, hasPlaceMarker, hasCaptcha, bodyText}` (object)
 * @returns `"blocked" | "results" | "single_place" | "no_results"`, or null when not decided yet
 */
export function classifySearchOutcome(searchProbe) {
  const { pageUrl, hasFeed, hasPlaceMarker, hasCaptcha, bodyText } = searchProbe;
  if (isBlockedPage(pageUrl, hasCaptcha)) return "blocked";
  if (hasFeed) return "results";
  if (isSinglePlaceUrl(pageUrl) || hasPlaceMarker) return "single_place";
  if (isNoResultsText(bodyText)) return "no_results";
  return null;
}

/**
 * Converts a Playwright launch failure into a PluginError with an actionable message.
 *
 * @param launchError - Error thrown by `chromium.launch` (Error)
 * @returns PluginError of kind `setup_required` or `browser_error`
 */
export function classifyLaunchError(launchError) {
  const message = String(launchError?.message ?? launchError);
  if (/Executable doesn't exist/i.test(message)) {
    return new PluginError(
      "Chromium for Playwright is not installed. Run `npx playwright install chromium` in the google-maps-scraper plugin directory.",
      { kind: "setup_required" },
    );
  }
  return new PluginError(`Failed to start the browser: ${message}`, { kind: "browser_error" });
}

// Template-resolved config (e.g. "{{#start.n#}}") can arrive as a string.
function parseWholeNumber(rawValue) {
  if (typeof rawValue === "string" && /^\s*\d+\s*$/.test(rawValue)) return Number(rawValue);
  return rawValue;
}

// Returns an absolute http(s) URL, unwrapping a Google `/url?q=` redirect; null otherwise.
function normalizeWebsiteHref(href) {
  let websiteUrl;
  try {
    websiteUrl = new URL(href);
  } catch {
    return null;
  }
  const isGoogleRedirect = websiteUrl.pathname === "/url" && /(^|\.)google\./.test(websiteUrl.hostname);
  const redirectTarget = isGoogleRedirect ? websiteUrl.searchParams.get("q") : null;
  if (redirectTarget) return normalizeWebsiteHref(redirectTarget);
  return websiteUrl.protocol === "https:" || websiteUrl.protocol === "http:" ? websiteUrl.href : null;
}

function cleanLabel(label, prefixPattern) {
  const cleaned = label.replace(prefixPattern, "").trim();
  return cleaned === "" ? null : cleaned;
}

function invalidInput(message) {
  return new PluginError(message, { kind: "invalid_input" });
}
