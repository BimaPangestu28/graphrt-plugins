import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));

// The live view helper is tested in google-maps-scraper/test/live-view.test.mjs; this plugin ships a copy.
test("lib/live-view.mjs is the same as google-maps-scraper's copy", () => {
  const ownCopy = readFileSync(join(testDirectory, "..", "lib", "live-view.mjs"), "utf8");
  const sourceCopy = readFileSync(join(testDirectory, "..", "..", "google-maps-scraper", "lib", "live-view.mjs"), "utf8");
  assert.equal(ownCopy, sourceCopy, "copy google-maps-scraper/lib/live-view.mjs to web-browser/lib/live-view.mjs");
});
