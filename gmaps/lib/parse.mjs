/**
 * Pure helpers for the gmaps plugin: config validation, URL building and
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
  const { query, max_results: maxResults = DEFAULT_MAX_RESULTS, language = DEFAULT_LANGUAGE, headless = true } =
    config ?? {};

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
 * Extracts phone, address and website from a place page's `[data-item-id]` buttons.
 *
 * @param placeItems - Items as `{itemId, label}` (Array<object>)
 * @returns `{phone, address, website}`, each null when absent
 */
export function extractPlaceDetails(placeItems) {
  const placeDetails = { phone: null, address: null, website: null };
  for (const { itemId = "", label = "" } of placeItems ?? []) {
    if (itemId.startsWith(PHONE_ITEM_PREFIX) && placeDetails.phone === null) {
      placeDetails.phone = normalizePhone(itemId.slice(PHONE_ITEM_PREFIX.length)) ?? normalizePhone(label);
    } else if (itemId === "address" && placeDetails.address === null) {
      placeDetails.address = cleanLabel(label, ADDRESS_PREFIX);
    } else if (itemId === "authority" && placeDetails.website === null) {
      placeDetails.website = cleanLabel(label, WEBSITE_PREFIX);
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
 * @param pageUrl - Current page URL (string)
 * @param bodyText - Visible page text (string)
 * @returns True when Google is asking for a CAPTCHA (boolean)
 */
export function isBlockedPage(pageUrl, bodyText) {
  return pageUrl.includes("/sorry/") || /unusual traffic/i.test(bodyText ?? "");
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
      "Chromium for Playwright is not installed. Run `npx playwright install chromium` in the gmaps plugin directory.",
      { kind: "setup_required" },
    );
  }
  return new PluginError(`Failed to start the browser: ${message}`, { kind: "browser_error" });
}

function cleanLabel(label, prefixPattern) {
  const cleaned = label.replace(prefixPattern, "").trim();
  return cleaned === "" ? null : cleaned;
}

function invalidInput(message) {
  return new PluginError(message, { kind: "invalid_input" });
}
