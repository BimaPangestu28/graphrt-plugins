/**
 * The name glob matcher: `*` and `?` semantics, case handling, and linear time on hostile patterns.
 * Identical in the local-files and file-watcher plugins.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGlobMatcher } from "../lib/directory-walker.mjs";

test("* matches any run, ? one character, everything else literally", () => {
  const cases = [
    ["*.md", "README.md", true],
    ["*.md", "README.mdx", false],
    ["a?c", "abc", true],
    ["a?c", "ac", false],
    ["*", "", true],
    ["file[1].txt", "file[1].txt", true],
    ["file[1].txt", "file1.txt", false],
    ["a.b", "axb", false],
    ["**x**", "abxcd", true],
    ["é?", "éa", true],
  ];
  for (const [pattern, name, expected] of cases) assert.equal(createGlobMatcher(pattern, true)(name), expected, `${pattern} ~ ${name}`);
});

test("case-insensitive unless asked", () => {
  assert.equal(createGlobMatcher("*.MD", false)("readme.md"), true);
  assert.equal(createGlobMatcher("*.MD", true)("readme.md"), false);
});

test("hostile patterns run in linear-ish time (no backtracking blow-up)", () => {
  const started = Date.now();
  const matches = createGlobMatcher(`${"*a".repeat(50)}b`, true);
  assert.equal(matches("a".repeat(10000)), false);
  assert.equal(createGlobMatcher(`${"*a".repeat(5)}b`, false)("a".repeat(255)), false);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
});
