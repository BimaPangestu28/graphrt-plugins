import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertAllowedPath, buildCatalog, buildCatalogEntry, describeTarballBytes, extractCatalogWarning, findCatalogRegressions, formatSha256Sums,
  isPinnedPath, releaseTagFor, sha256Hex, tarballNameFor, withChecksums,
} from "../lib/plugin-package.mjs";
import { extractReadmeWarnings } from "../lib/release-notes.mjs";
import { readPluginStatuses } from "../lib/plugin-status.mjs";
import { createTarGz } from "../lib/tar-archive.mjs";
import { REPO_ROOT } from "../plugins.mjs";

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
  assert.deepEqual(entry.nodes, [{ kind: "meta-api.get_page", title: "Get page", description: "Reads a page", config_schema: {} }]);
  assert.equal(entry.operations_count, 1);
  assert.equal(entry.warning, null);
  assert.deepEqual(entry.tools, ["get_page"]);
  assert.equal(entry.needs_browser, false);
  assert.equal(entry.node, ">=20");
  assert.equal(entry.size_bytes, 123);
});

test("carries the maturity status and ToS risk from plugin-status.json", () => {
  const pluginStatuses = { "meta-api": { status: "beta", reason: "Checked live with an invalid token only.", tos_risk: "low", tos_notes: "Spam rules." } };
  const entry = buildCatalogEntry(sampleManifest, { sha256: "0", sizeBytes: 1 }, pluginStatuses);
  assert.equal(entry.status, "beta");
  assert.equal(entry.status_reason, "Checked live with an invalid token only.");
  assert.equal(entry.tos_risk, "low");
  const repoEntry = buildCatalogEntry({ ...sampleManifest, name: "whatsapp-web", nodes: [] }, { sha256: "0", sizeBytes: 1 });
  assert.equal(repoEntry.status, "experimental");
  assert.equal(repoEntry.tos_risk, "high");
  assert.throws(() => buildCatalogEntry({ ...sampleManifest, name: "ghost" }, { sha256: "0", sizeBytes: 1 }), /ghost: no entry in plugin-status.json/);
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

test("copies each node's config_schema verbatim and its outputs when declared", () => {
  const configSchema = { type: "object", required: ["page_id"], properties: { page_id: { type: "string", description: "Page id" }, limit: { type: "integer", minimum: 1, default: 25 } } };
  const outputs = [{ name: "data", type: "any", description: "API result" }];
  const manifest = {
    ...sampleManifest,
    nodes: [
      { kind: "meta-api.get_page", title: "Get page", description: "Reads a page", category: "integration", config_schema: configSchema, outputs },
      { kind: "meta-api.ping", config_schema: { type: "object" } },
    ],
  };
  const entry = buildCatalogEntry(manifest, { sha256: "0", sizeBytes: 1 });
  assert.deepEqual(entry.nodes[0], { kind: "meta-api.get_page", title: "Get page", description: "Reads a page", config_schema: configSchema, outputs });
  assert.deepEqual(entry.nodes[1], { kind: "meta-api.ping", title: "meta-api.ping", description: "", config_schema: { type: "object" } });
  assert.equal("outputs" in entry.nodes[1], false);
  assert.equal(entry.operations_count, 2);
});

test("copies every real manifest's node schemas verbatim", () => {
  for (const pluginName of ["meta-api", "whatsapp-web", "google-maps-scraper"]) {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, pluginName, "graphrt-plugin.json"), "utf8"));
    const entry = buildCatalogEntry(manifest, { sha256: "0", sizeBytes: 1 });
    assert.equal(entry.operations_count, manifest.nodes.length, pluginName);
    entry.nodes.forEach((catalogNode, index) => {
      assert.deepEqual(catalogNode.config_schema, manifest.nodes[index].config_schema, catalogNode.kind);
      assert.deepEqual(catalogNode.outputs, manifest.nodes[index].outputs, catalogNode.kind);
    });
  }
});

test("takes the first README warning blockquote as the catalog warning", () => {
  const readme = "# x\n\n> Just a quote\n\n> **Warning:** breaks the **Terms of Service**.\n> Keep `volumes` low.\n\n> **Warning:** second one\n";
  assert.equal(extractCatalogWarning(readme), "breaks the **Terms of Service**. Keep `volumes` low.");
  assert.equal(extractCatalogWarning("# x\n\n> Just a quote\n"), null);
  const entry = buildCatalogEntry(sampleManifest, { sha256: "0", sizeBytes: 1, readmeText: readme });
  assert.equal(entry.warning, "breaks the **Terms of Service**. Keep `volumes` low.");
});

test("finds a Terms of Service warning in every high-risk plugin README, and none in meta-api", () => {
  const readCatalogWarning = (pluginName) => extractCatalogWarning(readFileSync(join(REPO_ROOT, pluginName, "README.md"), "utf8"));
  assert.match(readCatalogWarning("whatsapp-web"), /^automating a personal WhatsApp account breaks WhatsApp's Terms of Service.*\*\*banned\*\*/);
  assert.match(readCatalogWarning("google-maps-scraper"), /Terms of Service.*google-maps-platform/);
  for (const pluginName of ["fonnte", "wablas"]) assert.match(readCatalogWarning(pluginName), /^unofficial: .*\*\*banned\*\*.*whatsapp-api/, pluginName);
  assert.match(readCatalogWarning("linkedin-api"), /automate posting/);
  const highRiskPlugins = Object.entries(readPluginStatuses()).filter(([, statusEntry]) => statusEntry.tos_risk === "high").map(([pluginName]) => pluginName);
  assert.deepEqual(highRiskPlugins.sort(), ["fonnte", "google-maps-scraper", "linkedin-api", "wablas", "whatsapp-web"]);
  for (const pluginName of highRiskPlugins) assert.match(readCatalogWarning(pluginName) ?? "", /[Tt]erms/, pluginName);
  assert.equal(readCatalogWarning("meta-api"), null);
});

test("describes a published tarball from its own bytes, keeping sha256 and size", () => {
  const manifest = { ...sampleManifest, checksums: { "plugin.mjs": "ab" } };
  const tarballBytes = createTarGz(
    [
      { path: "meta-api", type: "directory" },
      { path: "meta-api/graphrt-plugin.json", type: "file", content: Buffer.from(JSON.stringify(manifest)) },
      { path: "meta-api/README.md", type: "file", content: Buffer.from("# meta\n\n> **Warning:** careful.\n") },
      { path: "meta-api/lib/graphrt-plugin.json", type: "file", content: Buffer.from("{}") },
    ],
    { mtimeSeconds: 0 },
  );
  const published = describeTarballBytes("meta-api-0.1.0.tar.gz", tarballBytes);
  assert.equal(published.sha256, sha256Hex(tarballBytes));
  assert.equal(published.sizeBytes, tarballBytes.length);
  assert.deepEqual(published.manifest, manifest);
  const entry = buildCatalogEntry(published.manifest, published);
  assert.equal(entry.sha256, sha256Hex(tarballBytes));
  assert.equal(entry.size_bytes, tarballBytes.length);
  assert.equal(entry.warning, "careful.");
  assert.throws(() => describeTarballBytes("x.tar.gz", createTarGz([{ path: "x", type: "directory" }], { mtimeSeconds: 0 })), /no graphrt-plugin.json/);
});

test("flags rebuilt catalogs that drop plugins or change their tarballs", () => {
  const previousEntry = buildCatalogEntry(sampleManifest, { sha256: "a".repeat(64), sizeBytes: 10 });
  const previousCatalog = buildCatalog([previousEntry, { ...previousEntry, name: "x-api" }], new Date());
  const enrichedEntry = { ...previousEntry, warning: null, nodes: [] };
  assert.deepEqual(findCatalogRegressions(previousCatalog, [enrichedEntry, { ...previousEntry, name: "x-api" }]), []);
  assert.deepEqual(findCatalogRegressions(previousCatalog, [{ ...enrichedEntry, sha256: "b", size_bytes: 11 }]), [
    `meta-api: sha256 ${"a".repeat(64)} -> b`,
    "meta-api: size_bytes 10 -> 11",
    "x-api: missing from the rebuilt catalog",
  ]);
});
