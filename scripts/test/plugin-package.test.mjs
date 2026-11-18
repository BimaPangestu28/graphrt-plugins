import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertAllowedPath, buildCatalog, buildCatalogEntry, formatSha256Sums, isPinnedPath, releaseTagFor, tarballNameFor, withChecksums,
} from "../lib/plugin-package.mjs";
import { extractReadmeWarnings } from "../lib/release-notes.mjs";

const sampleManifest = {
  name: "meta-api",
  version: "0.1.0",
  description: "Meta Graph API",
  runtime: "process",
  command: "node",
  args: ["plugin.mjs"],
  permissions: { network: true, secrets: true, env: ["META_ACCESS_TOKEN"] },
  nodes: [{ kind: "meta-api.get_page", title: "Get page", description: "Reads a page", config_schema: {} }],
  tools: [{ name: "get_page", description: "Reads a page", parameters: {} }],
};

test("names tags and tarballs from the plugin name and version", () => {
  assert.equal(releaseTagFor("meta-api", "0.1.0"), "meta-api-v0.1.0");
  assert.equal(tarballNameFor("meta-api", "0.1.0"), "meta-api-0.1.0.tar.gz");
});

test("pins code and JSON outside node_modules, never the manifest itself", () => {
  assert.equal(isPinnedPath("plugin.mjs"), true);
  assert.equal(isPinnedPath("lib/shared/operations.mjs"), true);
  assert.equal(isPinnedPath("package-lock.json"), true);
  assert.equal(isPinnedPath("graphrt-plugin.json"), false);
  assert.equal(isPinnedPath("README.md"), false);
  assert.equal(isPinnedPath("node_modules/playwright/index.js"), false);
});

test("refuses secrets, caches, profiles and session data", () => {
  for (const forbiddenPath of [".env", "lib/.env.local", ".claude/settings.json", "node_modules/.cache/x", "profile/Default/Cookies", "key.pem"]) {
    assert.throws(() => assertAllowedPath(forbiddenPath), /refusing to ship/, forbiddenPath);
  }
  assert.doesNotThrow(() => assertAllowedPath("lib/profile-lock.mjs"));
  assert.doesNotThrow(() => assertAllowedPath("node_modules/playwright-core/lib/server/environment.js"));
});

test("adds checksums before nodes and requires the entrypoint", () => {
  const released = withChecksums(sampleManifest, { "plugin.mjs": "ab" });
  assert.deepEqual(Object.keys(released).indexOf("checksums") + 1, Object.keys(released).indexOf("nodes"));
  assert.throws(() => withChecksums(sampleManifest, { "lib/a.mjs": "ab" }), /entrypoint plugin.mjs must be pinned/);
});

test("builds a catalog entry with download and readme URLs", () => {
  const entry = buildCatalogEntry(sampleManifest, { sha256: "f".repeat(64), sizeBytes: 123 });
  assert.equal(entry.tarball_url, "https://github.com/BimaPangestu28/graphrt-plugins/releases/download/meta-api-v0.1.0/meta-api-0.1.0.tar.gz");
  assert.equal(entry.readme_url, "https://github.com/BimaPangestu28/graphrt-plugins/blob/meta-api-v0.1.0/meta-api/README.md");
  assert.deepEqual(entry.permissions, { network: true, secrets: true, env: ["META_ACCESS_TOKEN"] });
  assert.deepEqual(entry.nodes, [{ kind: "meta-api.get_page", title: "Get page", description: "Reads a page" }]);
  assert.deepEqual(entry.tools, ["get_page"]);
  assert.equal(entry.needs_browser, false);
  assert.equal(entry.node, ">=20");
  assert.equal(entry.size_bytes, 123);
});

test("marks Playwright plugins as needing a browser", () => {
  const entry = buildCatalogEntry({ ...sampleManifest, name: "whatsapp-web", nodes: [] }, { sha256: "0", sizeBytes: 1 });
  assert.equal(entry.needs_browser, true);
});

test("sorts catalog plugins and uses an RFC 3339 timestamp", () => {
  const catalog = buildCatalog([{ name: "b" }, { name: "a" }], new Date("2026-11-18T10:00:00.123Z"));
  assert.equal(catalog.schema, 1);
  assert.equal(catalog.generated_at, "2026-11-18T10:00:00Z");
  assert.deepEqual(catalog.plugins.map((plugin) => plugin.name), ["a", "b"]);
});

test("formats SHA256SUMS like sha256sum", () => {
  assert.equal(formatSha256Sums([{ fileName: "b.tar.gz", sha256: "22" }, { fileName: "a.tar.gz", sha256: "11" }]), "11  a.tar.gz\n22  b.tar.gz\n");
});

test("extracts README warning blockquotes only", () => {
  const readme = "# x\n\n> **Warning:** do not\n> spam.\n\n> Just a quote\n\ntext\n";
  assert.deepEqual(extractReadmeWarnings(readme), ["> **Warning:** do not\n> spam."]);
});
