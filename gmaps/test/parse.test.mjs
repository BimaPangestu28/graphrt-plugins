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
    { phone: "+62221234567", address: "Jl. Braga 1", website: "braga.id" },
  );
});

test("extractPlaceDetails returns nulls for a place without details", () => {
  assert.deepEqual(extractPlaceDetails([]), { phone: null, address: null, website: null });
  assert.deepEqual(extractPlaceDetails([{ itemId: "oh", label: "Jam buka" }]), {
    phone: null,
    address: null,
    website: null,
  });
});

test("extractPlaceDetails strips English address and website prefixes", () => {
  assert.deepEqual(
    extractPlaceDetails([
      { itemId: "address", label: "Address: 1 Main St" },
      { itemId: "authority", label: "Website: example.com" },
    ]),
    { phone: null, address: "1 Main St", website: "example.com" },
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

test("isBlockedPage detects the Google sorry page and unusual traffic notice", () => {
  assert.equal(isBlockedPage("https://www.google.com/sorry/index?continue=x", ""), true);
  assert.equal(
    isBlockedPage("https://www.google.com/maps/search/x", "Our systems have detected unusual traffic from your network"),
    true,
  );
  assert.equal(isBlockedPage("https://www.google.com/maps/search/x", "Hasil pencarian"), false);
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
