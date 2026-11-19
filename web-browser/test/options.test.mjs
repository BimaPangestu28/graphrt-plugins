import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFieldSpecs, shapeFieldResults } from "../lib/field-specs.mjs";
import { filterLinks, validateLinkFilter } from "../lib/link-filter.mjs";
import { resolveSettings } from "../lib/settings.mjs";

const LINKS = [
  { url: "https://example.com/blog/post-1", text: "Post 1" },
  { url: "https://www.example.com/about", text: "About" },
  { url: "https://docs.example.com/guide", text: "Docs" },
  { url: "https://other.org/blog/x", text: "Other" },
  { url: "https://notexample.com/", text: "Look-alike" },
];

test("filterLinks scopes: all, same_host (ignores www.) and same_domain (subdomains)", () => {
  const pageUrl = "https://www.example.com/";
  assert.equal(filterLinks(LINKS, { pageUrl, scope: "all" }).length, 5);
  assert.deepEqual(filterLinks(LINKS, { pageUrl, scope: "same_host" }).map((link) => link.text), ["Post 1", "About"]);
  assert.deepEqual(filterLinks(LINKS, { pageUrl, scope: "same_domain" }).map((link) => link.text), ["Post 1", "About", "Docs"]);
});

test("filterLinks patterns: wildcard over the full URL, substring without *", () => {
  const pageUrl = "https://example.com/";
  assert.deepEqual(filterLinks(LINKS, { pageUrl, pattern: "*/blog/*" }).map((link) => link.text), ["Post 1", "Other"]);
  assert.deepEqual(filterLinks(LINKS, { pageUrl, pattern: "BLOG" }).map((link) => link.text), ["Post 1", "Other"]);
  assert.deepEqual(filterLinks(LINKS, { pageUrl, pattern: "https://*.example.com/*" }).map((link) => link.text), ["About", "Docs"]);
});

test("validateLinkFilter refuses unknown scopes and long patterns", () => {
  assert.throws(() => validateLinkFilter({ scope: "galaxy" }), { kind: "invalid_input" });
  assert.throws(() => validateLinkFilter({ scope: "all", pattern: "x".repeat(301) }), { kind: "invalid_input" });
  assert.equal(validateLinkFilter({ scope: "all", pattern: "  " }), null);
});

test("normalizeFieldSpecs accepts selector strings and objects", () => {
  assert.deepEqual(normalizeFieldSpecs({ title: "h1", next: { selector: "a.next", attribute: "href" }, prices: { selector: ".price", all: "true" } }), [
    { name: "title", selector: "h1", attribute: null, all: false },
    { name: "next", selector: "a.next", attribute: "href", all: false },
    { name: "prices", selector: ".price", attribute: null, all: true },
  ]);
});

const BAD_FIELDS = [
  ["no fields", {}],
  ["bad name", { "bad-name": "h1" }],
  ["empty selector", { title: "  " }],
  ["long selector", { title: "a".repeat(501) }],
  ["bad attribute", { title: { selector: "h1", attribute: "on click" } }],
  ["array spec", { title: ["h1"] }],
  ["bad all", { title: { selector: "h1", all: "maybe" } }],
  ["too many", Object.fromEntries(Array.from({ length: 31 }, (unused, index) => [`f${index}`, "p"]))],
];

for (const [label, fields] of BAD_FIELDS) {
  test(`normalizeFieldSpecs refuses ${label}`, () => {
    assert.throws(() => normalizeFieldSpecs(fields), { kind: "invalid_input" });
  });
}

test("shapeFieldResults returns first values, arrays for all, and per-field errors", () => {
  const specs = normalizeFieldSpecs({ title: "h1", prices: { selector: ".p", all: true }, missing: "h6", broken: "::bad" });
  const shaped = shapeFieldResults(specs, {
    title: { values: ["Hello"], matchCount: 2 },
    prices: { values: ["1", "2"], matchCount: 2 },
    missing: { values: [], matchCount: 0 },
    broken: { error: "invalid CSS selector" },
  });
  assert.deepEqual(shaped, {
    fields: { title: "Hello", prices: ["1", "2"], missing: null, broken: null },
    match_counts: { title: 2, prices: 2, missing: 0 },
    errors: { broken: "invalid CSS selector" },
  });
});

test("resolveSettings applies defaults", () => {
  assert.deepEqual(resolveSettings({ HOME: "/home/test" }), {
    screenshotDirectory: "/home/test/.graphrt/web-browser/screenshots",
    respectRobots: true,
    idleTimeoutMs: 300000,
    maxConcurrentPages: 2,
    maxDownloadBytes: 15 * 1024 * 1024,
    userAgentOverride: null,
    liveViewDirectory: null,
  });
});

test("resolveSettings reads every variable", () => {
  const settings = resolveSettings({
    HOME: "/home/test",
    WEB_BROWSER_SCREENSHOT_DIR: "~/shots",
    WEB_BROWSER_RESPECT_ROBOTS: "0",
    WEB_BROWSER_IDLE_MINUTES: "1",
    WEB_BROWSER_MAX_PAGES: "4",
    WEB_BROWSER_MAX_DOWNLOAD_MB: "5",
    WEB_BROWSER_USER_AGENT: "MyBot/1.0",
    GRAPHRT_LIVE_VIEW_DIR: "/tmp/live-view",
  });
  assert.deepEqual(settings, {
    screenshotDirectory: "/home/test/shots",
    respectRobots: false,
    idleTimeoutMs: 60000,
    maxConcurrentPages: 4,
    maxDownloadBytes: 5 * 1024 * 1024,
    userAgentOverride: "MyBot/1.0",
    liveViewDirectory: "/tmp/live-view",
  });
});

const BAD_SETTINGS = [
  { WEB_BROWSER_SCREENSHOT_DIR: "relative/dir" },
  { WEB_BROWSER_RESPECT_ROBOTS: "sometimes" },
  { WEB_BROWSER_MAX_PAGES: "9" },
  { WEB_BROWSER_MAX_PAGES: "1.5" },
  { WEB_BROWSER_MAX_DOWNLOAD_MB: "0" },
  { WEB_BROWSER_IDLE_MINUTES: "abc" },
  { WEB_BROWSER_USER_AGENT: "two\nlines" },
];

for (const environment of BAD_SETTINGS) {
  test(`resolveSettings refuses ${JSON.stringify(environment)}`, () => {
    assert.throws(() => resolveSettings({ HOME: "/h", ...environment }), { kind: "invalid_input" });
  });
}
