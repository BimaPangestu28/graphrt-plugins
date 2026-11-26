import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATALOG_V2_INDEX_NAME, CATALOG_V2_WARNING_BYTES, MAX_CATALOG_V2_BYTES, buildCatalogV2, buildCatalogV2Entry, buildPluginDetail,
  detailConflictError, planDetailUploads, pluginDetailAssetName, renderCatalogV2Text, renderPluginDetail,
} from "../lib/catalog-v2.mjs";
import { buildCatalog, buildCatalogEntry, listPluginNames, renderCatalogTextWithinLimit, sha256Hex } from "../lib/plugin-package.mjs";
import { writeCatalogFiles } from "../pack-plugins.mjs";
import { REPO_ROOT } from "../plugins.mjs";

const sampleManifest = {
  name: "meta-api",
  version: "0.1.0",
  description: "Meta Graph API",
  permissions: { network: true, secrets: true, env: ["META_ACCESS_TOKEN"] },
  checksums: { "plugin.mjs": "ab" },
  nodes: [
    { kind: "meta-api.get_page", title: "Get page", description: "Reads a page", config_schema: { type: "object", properties: { page_id: { type: "string" } } }, outputs: [{ name: "data", type: "any" }] },
    { kind: "meta-api.no_title", config_schema: {} },
  ],
  tools: [{ name: "get_page", description: "Reads a page", parameters: { type: "object" } }, { name: "bare_tool" }],
};

const V2_ENTRY_KEYS = [
  "name", "display_name", "version", "description", "icon_url", "tarball_url", "sha256", "size_bytes", "permissions", "needs_browser", "node",
  "warning", "status", "status_reason", "tos_risk", "source", "publisher", "repository_url", "operations_count", "tools", "node_kinds", "readme_url", "detail_url", "detail_sha256",
  "detail_size_bytes",
];

function readRepoManifest(pluginName) {
  return JSON.parse(readFileSync(join(REPO_ROOT, pluginName, "graphrt-plugin.json"), "utf8"));
}

function sampleV1Entry(manifest = sampleManifest) {
  return buildCatalogEntry(manifest, { sha256: "f".repeat(64), sizeBytes: 123 }, undefined, () => ({ assetName: "icon-meta-api-0123456789ab.svg" }));
}

test("names detail files by plugin and version", () => {
  assert.equal(pluginDetailAssetName("currency-rates", "0.1.0"), "plugin-currency-rates-0.1.0.json");
});

test("builds a detail file from the released manifest only, as compact JSON", () => {
  const detail = buildPluginDetail(sampleManifest);
  assert.deepEqual(detail, {
    schema: 2,
    name: "meta-api",
    version: "0.1.0",
    nodes: [
      { kind: "meta-api.get_page", title: "Get page", description: "Reads a page", config_schema: sampleManifest.nodes[0].config_schema, outputs: [{ name: "data", type: "any" }] },
      { kind: "meta-api.no_title", title: "meta-api.no_title", description: "", config_schema: {} },
    ],
    tools: [{ name: "get_page", description: "Reads a page" }, { name: "bare_tool", description: "" }],
  });
  const rendered = renderPluginDetail(detail);
  assert.equal(rendered.assetName, "plugin-meta-api-0.1.0.json");
  assert.equal(rendered.bytes.toString("utf8"), `${JSON.stringify(detail)}\n`);
  assert.equal(rendered.sha256, sha256Hex(rendered.bytes));
  assert.equal(rendered.sizeBytes, rendered.bytes.length);
  assert.deepEqual(renderPluginDetail(buildPluginDetail(structuredClone(sampleManifest))).bytes, rendered.bytes, "same manifest, same bytes");
});

test("builds a slim v2 index entry that links its detail file", () => {
  const rendered = renderPluginDetail(buildPluginDetail(sampleManifest));
  const entry = buildCatalogV2Entry(sampleV1Entry(), rendered);
  assert.deepEqual(Object.keys(entry), V2_ENTRY_KEYS);
  assert.deepEqual(entry.node_kinds, [{ kind: "meta-api.get_page", title: "Get page" }, { kind: "meta-api.no_title", title: "meta-api.no_title" }]);
  assert.deepEqual(entry.tools, ["get_page", "bare_tool"]);
  assert.equal(entry.operations_count, 2);
  assert.equal(entry.detail_url, "https://github.com/Graphrt/graphrt-plugins/releases/download/catalog/plugin-meta-api-0.1.0.json");
  assert.equal(entry.detail_sha256, rendered.sha256);
  assert.equal(entry.detail_size_bytes, rendered.sizeBytes);
  assert.equal(JSON.stringify(entry).includes("config_schema"), false);
  const otherVersion = renderPluginDetail(buildPluginDetail({ ...sampleManifest, version: "0.2.0" }));
  assert.throws(() => buildCatalogV2Entry(sampleV1Entry(), otherVersion), /belongs to another version/);
});

test("builds index-v2.json with schema 2, sorted plugins and a size guard", () => {
  const generatedAt = new Date("2026-11-21T10:00:00.123Z");
  const entries = ["zeta", "alpha"].map((name) => ({ name }));
  const catalogV2 = buildCatalogV2(entries, generatedAt);
  assert.deepEqual(catalogV2, { schema: 2, generated_at: "2026-11-21T10:00:00Z", plugins: [{ name: "alpha" }, { name: "zeta" }] });
  const small = renderCatalogV2Text(catalogV2);
  assert.equal(small.catalogText, `${JSON.stringify(catalogV2)}\n`);
  assert.equal(small.warning, null);
  const large = renderCatalogV2Text({ ...catalogV2, plugins: [{ name: "big", description: "x".repeat(CATALOG_V2_WARNING_BYTES) }] });
  assert.match(large.warning, /index-v2\.json is \d+ bytes \(warning above 1048576\)/);
  assert.throws(() => renderCatalogV2Text({ ...catalogV2, plugins: [{ name: "huge", description: "x".repeat(MAX_CATALOG_V2_BYTES) }] }), /accepts at most 4194304/);
});

test("the full v2 index stays well under its warning size", () => {
  const generatedAt = new Date();
  const entries = listPluginNames().map((pluginName) => {
    const manifest = readRepoManifest(pluginName);
    const catalogEntry = buildCatalogEntry(manifest, { sha256: "f".repeat(64), sizeBytes: 1_000_000, readmeText: readFileSync(join(REPO_ROOT, pluginName, "README.md"), "utf8") });
    return buildCatalogV2Entry(catalogEntry, renderPluginDetail(buildPluginDetail(manifest)));
  });
  const { sizeBytes, warning } = renderCatalogV2Text(buildCatalogV2(entries, generatedAt));
  assert.equal(warning, null);
  assert.ok(sizeBytes < 500 * 1024, `index-v2.json is ${sizeBytes} bytes`);
});

test("plans only missing detail uploads and refuses published details with other bytes", () => {
  const staged = [{ assetName: "plugin-a-0.1.0.json", sha256: "1".repeat(64) }, { assetName: "plugin-b-0.1.0.json", sha256: "2".repeat(64) }, { assetName: "plugin-c-0.1.0.json", sha256: "3".repeat(64) }];
  const published = new Map([["plugin-a-0.1.0.json", "1".repeat(64)], ["plugin-b-0.1.0.json", "9".repeat(64)]]);
  const { newDetails, conflicts } = planDetailUploads(staged, published);
  assert.deepEqual(newDetails, [staged[2]]);
  assert.deepEqual(conflicts, [`plugin-b-0.1.0.json: published sha256 ${"9".repeat(64)}, rebuilt ${"2".repeat(64)}`]);
  assert.deepEqual(planDetailUploads(staged, new Map()).newDetails, staged);
  const error = detailConflictError(conflicts);
  assert.match(error.message, /refusing to publish: 1 detail file\(s\) on the catalog release are immutable/);
  assert.match(error.message, /plugin-b-0\.1\.0\.json/);
});

test("writes v1 in full while it fits, and without node schemas when it would not", () => {
  const catalog = buildCatalog([sampleV1Entry()], new Date("2026-11-21T10:00:00Z"));
  const fullText = `${JSON.stringify(catalog)}\n`;
  assert.deepEqual(renderCatalogTextWithinLimit(catalog), { catalogText: fullText, withoutSchemas: false, fullSizeBytes: Buffer.byteLength(fullText) });
  const slim = renderCatalogTextWithinLimit(catalog, Buffer.byteLength(fullText) - 1);
  assert.equal(slim.withoutSchemas, true);
  const slimCatalog = JSON.parse(slim.catalogText);
  assert.deepEqual(slimCatalog.plugins[0].nodes, [
    { kind: "meta-api.get_page", title: "Get page", description: "Reads a page" },
    { kind: "meta-api.no_title", title: "meta-api.no_title", description: "" },
  ]);
  assert.deepEqual({ ...slimCatalog.plugins[0], nodes: null }, { ...catalog.plugins[0], nodes: null }, "only the node schemas are dropped");
  assert.throws(() => renderCatalogTextWithinLimit(catalog, 100), /index\.json is \d+ bytes; the desktop app accepts at most 100/);
});

test("writes index-v2.json and detail files next to index.json and lists them all in SHA256SUMS", () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "catalog-v2-"));
  try {
    const released = ["meta-api", "open-meteo"].map((pluginName) => {
      const manifest = readRepoManifest(pluginName);
      return { tarballName: `${pluginName}-${manifest.version}.tar.gz`, sha256: "a".repeat(64), manifest, catalogEntry: buildCatalogEntry(manifest, { sha256: "a".repeat(64), sizeBytes: 1 }) };
    });
    const { indexPath, indexV2Path, sumsPath, detailFiles, v1WithoutSchemas } = writeCatalogFiles(outputDirectory, released);
    const v1Catalog = JSON.parse(readFileSync(indexPath, "utf8"));
    const v2Catalog = JSON.parse(readFileSync(indexV2Path, "utf8"));
    const sums = readFileSync(sumsPath, "utf8");
    assert.equal(v1WithoutSchemas, false);
    assert.equal(v2Catalog.schema, 2);
    assert.equal(v2Catalog.generated_at, v1Catalog.generated_at);
    assert.deepEqual(readdirSync(join(outputDirectory, "details")).sort(), released.map(({ manifest }) => pluginDetailAssetName(manifest.name, manifest.version)).sort());
    for (const [index, entry] of v2Catalog.plugins.entries()) {
      const detailBytes = readFileSync(join(outputDirectory, "details", pluginDetailAssetName(entry.name, entry.version)));
      const detail = JSON.parse(detailBytes);
      assert.equal(entry.detail_sha256, sha256Hex(detailBytes));
      assert.equal(entry.detail_size_bytes, detailBytes.length);
      assert.deepEqual(detail.nodes, v1Catalog.plugins[index].nodes, "detail nodes are the v1 nodes");
      assert.deepEqual(entry.node_kinds, detail.nodes.map(({ kind, title }) => ({ kind, title })));
      assert.ok(sums.includes(`${entry.detail_sha256}  ${pluginDetailAssetName(entry.name, entry.version)}\n`));
    }
    assert.equal(detailFiles.length, 2);
    assert.ok(sums.includes(`${sha256Hex(readFileSync(indexPath))}  index.json\n`));
    assert.ok(sums.includes(`${sha256Hex(readFileSync(indexV2Path))}  ${CATALOG_V2_INDEX_NAME}\n`));
    assert.throws(() => writeCatalogFiles(outputDirectory, [{ ...released[0], manifest: undefined }]), /released manifest is needed/);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});
