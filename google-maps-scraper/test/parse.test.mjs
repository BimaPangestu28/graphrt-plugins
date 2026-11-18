import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSearchConfig,
  buildSearchUrl,
  normalizePhone,
  extractPlaceDetails,
  parseRating,
  collectPhones,
  isBlockedPage,
  classifyLaunchError,
  classifySearchOutcome,
  isNoResultsText,
  isSinglePlaceUrl,
} from "../lib/parse.mjs";

test("validateSearchConfig applies defaults", () => {
  assert.deepEqual(validateSearchConfig({ query: "cafe" }), {
    query: "cafe",
    maxResults: 20,
    language: "id",
    headless: true,
  });
});

test("validateSearchConfig trims query and reads explicit values", () => {
  assert.deepEqual(
    validateSearchConfig({ query: "  cafe  ", max_results: 5, language: "en", headless: false }),
    { query: "cafe", maxResults: 5, language: "en", headless: false },
  );
});

for (const [label, invalidConfig] of [
  ["empty query", { query: "" }],
  ["whitespace query", { query: "   " }],
  ["missing query", {}],
  ["max_results zero", { query: "x", max_results: 0 }],
  ["max_results above 100", { query: "x", max_results: 101 }],
  ["max_results fractional", { query: "x", max_results: 2.5 }],
  ["language not a code", { query: "x", language: "id&evil=1" }],
]) {
  test(`validateSearchConfig rejects ${label}`, () => {
    assert.throws(() => validateSearchConfig(invalidConfig), (error) => error.kind === "invalid_input");
  });
}

test("buildSearchUrl encodes special and non-ASCII characters", () => {
  assert.equal(
    buildSearchUrl("kopi & roti Bandung", "id"),
    "https://www.google.com/maps/search/kopi%20%26%20roti%20Bandung?hl=id",
  );
  assert.equal(buildSearchUrl("café", "en"), "https://www.google.com/maps/search/caf%C3%A9?hl=en");
});

test("normalizePhone strips tel prefix and separators", () => {
  assert.equal(normalizePhone("tel:+62 22-1234 (567)"), "+62221234567");
  assert.equal(normalizePhone("0812 3456 7890"), "081234567890");
  assert.equal(normalizePhone("  "), null);
  assert.equal(normalizePhone(undefined), null);
  assert.equal(normalizePhone(null), null);
});

test("extractPlaceDetails reads phone, address and website items", () => {
  assert.deepEqual(
    extractPlaceDetails([
      { itemId: "phone:tel:+62221234567", label: "Telepon: 022-1234567" },
      { itemId: "address", label: "Alamat: Jl. Braga 1" },
      { itemId: "authority", label: "braga.id" },
    ]),
    { phone: "+62221234567", address: "Jl. Braga 1", website: "braga.id", website_label: "braga.id" },
  );
});

test("extractPlaceDetails returns nulls for a place without details", () => {
  const emptyDetails = { phone: null, address: null, website: null, website_label: null };
  assert.deepEqual(extractPlaceDetails([]), emptyDetails);
  assert.deepEqual(extractPlaceDetails([{ itemId: "oh", label: "Jam buka" }]), emptyDetails);
});

test("extractPlaceDetails strips English address and website prefixes", () => {
  assert.deepEqual(
    extractPlaceDetails([
      { itemId: "address", label: "Address: 1 Main St" },
      { itemId: "authority", label: "Website: example.com" },
    ]),
    { phone: null, address: "1 Main St", website: "example.com", website_label: "example.com" },
  );
});

test("parseRating accepts comma and dot decimals", () => {
  assert.equal(parseRating("4,5"), 4.5);
  assert.equal(parseRating("4.7"), 4.7);
  assert.equal(parseRating(null), null);
  assert.equal(parseRating("n/a"), null);
});

test("collectPhones keeps unique non-null phones in order", () => {
  assert.deepEqual(collectPhones([{ phone: "1" }, { phone: null }, { phone: "1" }, { phone: "2" }]), ["1", "2"]);
});

test("isBlockedPage detects the Google sorry page", () => {
  assert.equal(isBlockedPage("https://www.google.com/sorry/index?continue=x", false), true);
});

test("isBlockedPage detects a CAPTCHA element on any page", () => {
  assert.equal(isBlockedPage("https://www.google.com/maps/search/x", true), true);
});

test("isBlockedPage ignores 'unusual traffic' text without a CAPTCHA element", () => {
  // A place review or name can contain the phrase; only the URL / element count.
  assert.equal(isBlockedPage("https://www.google.com/maps/place/x", "Our systems have detected unusual traffic"), false);
  assert.equal(isBlockedPage("https://www.google.com/maps/search/x", false), false);
});

test("extractPlaceDetails returns the authority href as website and keeps the label", () => {
  assert.deepEqual(
    extractPlaceDetails([{ itemId: "authority", label: "Situs Web: braga.id", href: "https://www.braga.id/menu?ref=maps" }]),
    { phone: null, address: null, website: "https://www.braga.id/menu?ref=maps", website_label: "braga.id" },
  );
});

test("extractPlaceDetails unwraps a Google redirect href", () => {
  const placeDetails = extractPlaceDetails([
    { itemId: "authority", label: "braga.id", href: "https://www.google.com/url?q=https://braga.id/&sa=U" },
  ]);
  assert.equal(placeDetails.website, "https://braga.id/");
});

test("extractPlaceDetails falls back to the label when the href is missing or not http(s)", () => {
  assert.equal(extractPlaceDetails([{ itemId: "authority", label: "braga.id", href: null }]).website, "braga.id");
  assert.equal(extractPlaceDetails([{ itemId: "authority", label: "braga.id", href: "javascript:void(0)" }]).website, "braga.id");
});

test("isSinglePlaceUrl matches only /maps/place/ URLs", () => {
  assert.equal(isSinglePlaceUrl("https://www.google.com/maps/place/Braga/@-6.9,107.6,17z"), true);
  assert.equal(isSinglePlaceUrl("https://www.google.com/maps/search/cafe?hl=id"), false);
  assert.equal(isSinglePlaceUrl("not a url"), false);
});

test("isNoResultsText recognises the English and Indonesian no-results notices", () => {
  assert.equal(isNoResultsText("Google Maps can't find zzqqxx"), true);
  assert.equal(isNoResultsText("Google Maps tidak dapat menemukan zzqqxx"), true);
  assert.equal(isNoResultsText("Kopi Braga 4,5 Kafe"), false);
});

test("classifySearchOutcome decides from the probe", () => {
  const searchUrl = "https://www.google.com/maps/search/x";
  const placeUrl = "https://www.google.com/maps/place/x";
  const emptyProbe = { pageUrl: searchUrl, hasFeed: false, hasPlaceMarker: false, hasCaptcha: false, bodyText: "" };
  assert.equal(classifySearchOutcome({ ...emptyProbe, pageUrl: "https://www.google.com/sorry/x" }), "blocked");
  assert.equal(classifySearchOutcome({ ...emptyProbe, hasCaptcha: true, hasFeed: true }), "blocked");
  assert.equal(classifySearchOutcome({ ...emptyProbe, hasFeed: true }), "results");
  assert.equal(classifySearchOutcome({ ...emptyProbe, pageUrl: placeUrl }), "single_place");
  assert.equal(classifySearchOutcome({ ...emptyProbe, hasPlaceMarker: true }), "single_place");
  assert.equal(classifySearchOutcome({ ...emptyProbe, bodyText: "Google Maps can't find x" }), "no_results");
  // A bare h1 (e.g. the "Results" heading) is not enough to decide.
  assert.equal(classifySearchOutcome({ ...emptyProbe, bodyText: "Results" }), null);
});

test("classifyLaunchError maps a missing browser to setup_required", () => {
  const classified = classifyLaunchError(new Error("browserType.launch: Executable doesn't exist at /x/chrome"));
  assert.equal(classified.kind, "setup_required");
  assert.match(classified.message, /npx playwright install chromium/);
});

test("classifyLaunchError maps other failures to browser_error", () => {
  const classified = classifyLaunchError(new Error("boom"));
  assert.equal(classified.kind, "browser_error");
  assert.match(classified.message, /boom/);
});

test("validateSearchConfig accepts max_results as a whole-number string from a template", () => {
  assert.equal(validateSearchConfig({ query: "x", max_results: "5" }).maxResults, 5);
  assert.equal(validateSearchConfig({ query: "x", max_results: " 12 " }).maxResults, 12);
  assert.throws(() => validateSearchConfig({ query: "x", max_results: "5.5" }), (error) => error.kind === "invalid_input");
  assert.throws(() => validateSearchConfig({ query: "x", max_results: "abc" }), (error) => error.kind === "invalid_input");
});
