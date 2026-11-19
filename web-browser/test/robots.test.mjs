import { test } from "node:test";
import assert from "node:assert/strict";
import { isPathAllowed, MAX_RULES_PER_GROUP, parseRobotsTxt, selectRules } from "../lib/robots.mjs";
import { matchesWildcard } from "../lib/wildcard.mjs";

const TOKEN = "graphrt-web-browser";

function isAllowed(robotsText, path) {
  return isPathAllowed(selectRules(parseRobotsTxt(robotsText), TOKEN), path);
}

test("parseRobotsTxt groups consecutive user-agent lines and ignores comments and unknown keys", () => {
  const groups = parseRobotsTxt("# hi\nUser-agent: a\nUser-Agent: B # comment\nDisallow: /x\nCrawl-delay: 5\nSitemap: https://e/s.xml\n\nuser-agent: *\nAllow: /y\nDisallow:\n");
  assert.deepEqual(groups, [
    { agents: ["a", "b"], rules: [{ allow: false, pattern: "/x" }] },
    { agents: ["*"], rules: [{ allow: true, pattern: "/y" }] },
  ]);
});

test("rules before any user-agent line are ignored", () => {
  assert.deepEqual(parseRobotsTxt("Disallow: /\n"), []);
});

const MATCHING_CASES = [
  ["no rules allow everything", "", "/anything", true],
  ["* group disallow", "User-agent: *\nDisallow: /private", "/private/page", false],
  ["prefix match does not need a slash", "User-agent: *\nDisallow: /priv", "/private", false],
  ["other paths stay allowed", "User-agent: *\nDisallow: /private", "/public", true],
  ["our group wins over *", "User-agent: *\nDisallow: /\n\nUser-agent: graphrt-web-browser\nAllow: /", "/x", true],
  ["our group matched case-insensitively", "User-agent: GraphRT-Web-Browser\nDisallow: /", "/x", false],
  ["other bots' groups do not apply", "User-agent: googlebot\nDisallow: /", "/x", true],
  ["longest rule wins", "User-agent: *\nDisallow: /a\nAllow: /a/b", "/a/b/c", true],
  ["longest rule wins (disallow)", "User-agent: *\nAllow: /a\nDisallow: /a/b", "/a/b/c", false],
  ["allow wins a tie", "User-agent: *\nDisallow: /a\nAllow: /a", "/a", true],
  ["$ anchors the end", "User-agent: *\nDisallow: /*.pdf$", "/doc.pdf", false],
  ["$ anchor does not match longer paths", "User-agent: *\nDisallow: /*.pdf$", "/doc.pdf?x=1", true],
  ["* in the middle", "User-agent: *\nDisallow: /shop/*/cart", "/shop/123/cart/view", false],
  ["query strings are matched", "User-agent: *\nDisallow: /search?q=", "/search?q=cats", false],
  ["percent-encoding is compared normalised", "User-agent: *\nDisallow: /caf%c3%a9", "/caf%C3%A9/menu", false],
  ["non-ASCII patterns match encoded paths", "User-agent: *\nDisallow: /café", "/caf%C3%A9", false],
  ["robots.txt itself is always allowed", "User-agent: *\nDisallow: /", "/robots.txt", true],
  ["disallow all", "User-agent: *\nDisallow: /", "/", false],
  ["groups for the same agent are merged", "User-agent: *\nDisallow: /a\n\nUser-agent: *\nDisallow: /b", "/b", false],
  ["a user-agent line with a version names our product token", "User-agent: graphrt-web-browser/1.0\nDisallow: /\n\nUser-agent: *\nAllow: /", "/x", false],
  ["a user-agent line with a comment-like suffix names our token", "User-agent: GraphRT-Web-Browser (compatible)\nDisallow: /", "/x", false],
  ["a longer product name is not our token", "User-agent: graphrt-web-browser-extra\nDisallow: /", "/x", true],
  ["an escaped unreserved character in the path matches the plain rule", "User-agent: *\nDisallow: /~joe", "/%7Ejoe", false],
  ["an escaped unreserved character in the rule matches the plain path", "User-agent: *\nDisallow: /%7Ejoe", "/~joe", false],
  ["escaped letters and digits are decoded", "User-agent: *\nDisallow: /%61dmin%31", "/admin1", false],
  ["escaped reserved characters stay escaped", "User-agent: *\nDisallow: /a%2Fb", "/a/b", true],
  ["a byte-order mark before the first line is ignored", "\uFEFFUser-agent: *\nDisallow: /", "/x", false],
];

for (const [label, robotsText, path, expected] of MATCHING_CASES) {
  test(`isPathAllowed: ${label}`, () => {
    assert.equal(isAllowed(robotsText, path), expected);
  });
}

test("hostile wildcard rules stay fast (no regex backtracking)", () => {
  const robotsText = `User-agent: *\nDisallow: /${"*a".repeat(40)}*b$`;
  const started = Date.now();
  assert.equal(isAllowed(robotsText, `/${"a".repeat(2000)}`), true);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
});

test("matchesWildcard matches whole strings with * as any run", () => {
  assert.equal(matchesWildcard("a*c", "abbbc"), true);
  assert.equal(matchesWildcard("a*c", "abbbcd"), false);
  assert.equal(matchesWildcard("*", ""), true);
  assert.equal(matchesWildcard("", ""), true);
  assert.equal(matchesWildcard("", "x"), false);
  assert.equal(matchesWildcard("**x**", "abxcd"), true);
  assert.equal(matchesWildcard("a.c", "abc"), false, "dots are literal");
});

function assertFast(label, robotsText, path) {
  const startedAt = performance.now();
  isAllowed(robotsText, path);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 500, `${label} took ${elapsedMs.toFixed(1)} ms`);
}

test("pathological robots.txt files are parsed and matched in well under a second (the unbounded matcher took ~1.9 s; the margin absorbs CI load)", () => {
  const oneHugeRule = `User-agent: *\nDisallow: /${"*a".repeat(250000)}b\n`;
  const manyStarRules = `User-agent: *\n${Array.from({ length: 10000 }, () => `Disallow: /${"*a".repeat(26)}*b`).join("\n")}`;
  const manyStarsOneRule = `User-agent: *\nDisallow: /${"*".repeat(100000)}a${"*".repeat(100000)}b`;
  const longPath = `/${"a".repeat(60000)}`;
  assertFast("one 500 KB rule, 2 KB path", oneHugeRule, `/${"a".repeat(2040)}`);
  assertFast("one 500 KB rule, 60 KB path", oneHugeRule, longPath);
  assertFast("10000 star rules, 2 KB path", manyStarRules, `/${"a".repeat(2040)}`);
  assertFast("10000 star rules, 60 KB path", manyStarRules, longPath);
  assertFast("runs of stars", manyStarsOneRule, longPath);
});

test("over-long rules and rules with too many wildcards are ignored; runs of * count as one", () => {
  const groups = parseRobotsTxt(`User-agent: *\nDisallow: /${"x".repeat(3000)}\nDisallow: /${"*a".repeat(40)}\nDisallow: /a***b**c\n`);
  assert.deepEqual(groups[0].rules, [{ allow: false, pattern: "/a*b*c" }]);
});

test("a check that runs out of matching work fails closed (disallowed)", () => {
  const rules = Array.from({ length: 2000 }, (unused, index) => ({ allow: true, pattern: `/${"*a".repeat(30)}*b${index}` }));
  assert.equal(isPathAllowed(rules, `/${"a".repeat(60000)}`), false);
});

test("groups keep at most MAX_RULES_PER_GROUP rules", () => {
  const robotsText = `User-agent: *\n${Array.from({ length: MAX_RULES_PER_GROUP + 50 }, (unused, index) => `Disallow: /p${index}`).join("\n")}`;
  assert.equal(parseRobotsTxt(robotsText)[0].rules.length, MAX_RULES_PER_GROUP);
});
