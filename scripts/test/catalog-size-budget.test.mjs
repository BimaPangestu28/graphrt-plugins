import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommunityPluginRejection, MAX_COMMUNITY_V1_ENTRY_BYTES, MAX_COMMUNITY_V1_STRIPPED_ENTRY_BYTES, MAX_COMMUNITY_V2_ENTRY_BYTES, assertCatalogFilesFit,
} from "../lib/community-ingest.mjs";
import { COMMUNITY_FALLBACK_ICON_SVG, validateIconBytes } from "../lib/plugin-icons.mjs";
import { assembleCatalogEntry, buildCatalogEntry } from "../lib/plugin-package.mjs";
import { fitCommunityPluginsIntoCatalog, measureCatalogSizes, writeCatalogFiles } from "../pack-plugins.mjs";
import { REPO_ROOT } from "../plugins.mjs";

/** A community catalog item like the audit's probe-size.mjs, with `nodeCount` nodes of `descriptionLength` characters. */
function communityItem(pluginName, { nodeCount, descriptionLength, schemaLength = 0 }) {
  const nodes = Array.from({ length: nodeCount }, (unused, index) => ({
    kind: `${pluginName}.op_${index}`,
    title: `Op ${index}`,
    description: "x".repeat(descriptionLength),
    config_schema: { type: "object", properties: { query: { type: "string", description: "q".repeat(schemaLength) } } },
  }));
  const manifest = { name: pluginName, version: "1.0.0", description: "A community plugin", nodes };
  const icon = validateIconBytes(pluginName, Buffer.from(COMMUNITY_FALLBACK_ICON_SVG));
  const catalogEntry = assembleCatalogEntry(manifest, { sha256: "0".repeat(64), sizeBytes: 1 }, {
    displayName: pluginName, iconAssetName: icon.assetName, tarballUrl: "https://example.invalid/x.tar.gz", needsBrowser: false,
    statusEntry: { status: "beta", reason: "r", tos_risk: "none" }, source: "community", publisher: "Acme", repositoryUrl: "https://github.com/acme/x",
    readmeUrl: "https://github.com/acme/x/blob/v1.0.0/README.md",
  });
  return { tarballName: `${pluginName}-1.0.0.tar.gz`, sha256: "0".repeat(64), manifest, catalogEntry, icon };
}

function officialItem(pluginName) {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, pluginName, "graphrt-plugin.json"), "utf8"));
  const item = { tarballName: `${pluginName}-${manifest.version}.tar.gz`, sha256: "b".repeat(64), sizeBytes: 10, manifest };
  return { ...item, catalogEntry: buildCatalogEntry(manifest, item) };
}

function rejectionReason(action) {
  try {
    action();
    return null;
  } catch (error) {
    assert.ok(error instanceof CommunityPluginRejection, error.stack);
    return error.reason;
  }
}

test("the audit's probe-size entries are refused by the per-entry budgets", () => {
  const probeItem = communityItem("aaa", { nodeCount: 500, descriptionLength: 1950 });
  assert.match(rejectionReason(() => assertCatalogFilesFit("aaa", probeItem, () => undefined)), new RegExp(`index.json entry is \\d+ bytes; the limit is ${MAX_COMMUNITY_V1_ENTRY_BYTES}`));
});

test("a community entry within the full budget but over the schema-stripped budget is refused", () => {
  const descriptionHeavy = communityItem("bbb", { nodeCount: 40, descriptionLength: 450 });
  assert.match(rejectionReason(() => assertCatalogFilesFit("bbb", descriptionHeavy, () => undefined)), new RegExp(`without node schemas .* the limit is ${MAX_COMMUNITY_V1_STRIPPED_ENTRY_BYTES}`));
});

test("node descriptions count toward the v2 entry budget although index-v2.json does not carry them", () => {
  const item = communityItem("ccc", { nodeCount: 30, descriptionLength: 500 });
  item.catalogEntry.nodes = item.catalogEntry.nodes.map((node) => ({ ...node, description: "y".repeat(500) }));
  const reason = rejectionReason(() => assertCatalogFilesFit("ccc", item, () => undefined, { maxV1StrippedBytes: Number.MAX_SAFE_INTEGER }));
  assert.match(reason, new RegExp(`index-v2.json entry with its node descriptions is \\d+ bytes; the limit is ${MAX_COMMUNITY_V2_ENTRY_BYTES}`));
});

test("entries that pass every per-entry budget never fail the publish: the largest community entries are dropped", () => {
  const officials = ["currency-rates", "open-meteo"].map(officialItem);
  const communities = [communityItem("small-one", { nodeCount: 2, descriptionLength: 10, schemaLength: 100 }), communityItem("large-one", { nodeCount: 8, descriptionLength: 10, schemaLength: 6000 }), communityItem("mid-one", { nodeCount: 4, descriptionLength: 10, schemaLength: 2000 })];
  const officialBytes = Buffer.byteLength(JSON.stringify({ plugins: officials.map(({ catalogEntry }) => catalogEntry) }));
  const maxV1Bytes = officialBytes + 20_000;
  const { kept, dropped } = fitCommunityPluginsIntoCatalog([...officials, ...communities], { generatedAt: new Date(0), maxV1Bytes });
  assert.deepEqual(kept.map(({ catalogEntry }) => catalogEntry.name), ["currency-rates", "open-meteo", "small-one", "mid-one"]);
  assert.deepEqual(dropped.map(({ name, source }) => [name, source]), [["large-one", "community"]]);
  assert.match(dropped[0].reason, /index.json would exceed \d+ bytes/);

  const catalogDirectory = mkdtempSync(join(tmpdir(), "catalog-size-budget-test-"));
  try {
    const catalogFiles = writeCatalogFiles(catalogDirectory, [...officials, ...communities], { maxV1Bytes });
    assert.equal(catalogFiles.v1WithoutSchemas, false, "official schemas are never stripped because of community size");
    assert.deepEqual(catalogFiles.skipped.map(({ name }) => name), ["large-one"]);
    const v1Catalog = JSON.parse(readFileSync(catalogFiles.indexPath, "utf8"));
    assert.ok(v1Catalog.plugins.every((entry) => entry.nodes.every((node) => node.config_schema)), "every node keeps its config_schema");
    assert.ok(!JSON.parse(readFileSync(catalogFiles.indexV2Path, "utf8")).plugins.some((entry) => entry.name === "large-one"));
  } finally {
    rmSync(catalogDirectory, { recursive: true, force: true });
  }
});

test("community entries are dropped to keep index-v2.json under its limit too", () => {
  const officials = [officialItem("currency-rates")];
  const communities = ["one", "two", "three"].map((pluginName) => communityItem(pluginName, { nodeCount: 20, descriptionLength: 10 }));
  const generatedAt = new Date(0);
  const officialV2Bytes = measureCatalogSizes(officials, generatedAt).v2Bytes;
  const oneCommunityV2Bytes = measureCatalogSizes([...officials, communities[0]], generatedAt).v2Bytes - officialV2Bytes;
  const { kept, dropped } = fitCommunityPluginsIntoCatalog([...officials, ...communities], { generatedAt, maxV2Bytes: officialV2Bytes + Math.floor(oneCommunityV2Bytes * 1.5) });
  assert.equal(kept.length, 2, "the official plugin and one community plugin fit");
  assert.ok(kept.some(({ catalogEntry }) => catalogEntry.name === "currency-rates"));
  assert.equal(dropped.length, 2);
  assert.ok(dropped.every(({ reason }) => /index-v2.json would exceed/.test(reason)));
});
