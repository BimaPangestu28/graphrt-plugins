import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPluginIcon } from "../lib/plugin-icons.mjs";
import { CATALOG_TAG, MAX_CATALOG_BYTES, buildCatalog, buildCatalogEntry, isShippedSourcePath, listPluginNames, releaseAssetUrl, renderCatalogText } from "../lib/plugin-package.mjs";
import { writeCatalogFiles } from "../pack-plugins.mjs";
import { REPO_ROOT } from "../plugins.mjs";

const ICON_ASSET_URL_PATTERN = new RegExp(`^https://github\\.com/[^/]+/[^/]+/releases/download/${CATALOG_TAG}/icon-[a-z0-9-]+-[0-9a-f]{12}\\.svg$`);

test("keeps icon.svg out of release tarballs (it ships with the catalog)", () => {
  assert.equal(isShippedSourcePath("icon.svg"), false);
  assert.equal(isShippedSourcePath("plugin.mjs"), true);
  assert.equal(isShippedSourcePath("assets/icon.svg"), true);
});

test("gives every catalog entry an icon_url on the catalog release, named by content", () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "meta-api", "graphrt-plugin.json"), "utf8"));
  const entry = buildCatalogEntry(manifest, { sha256: "0", sizeBytes: 1 });
  assert.equal(entry.icon_url, releaseAssetUrl(CATALOG_TAG, readPluginIcon("meta-api").assetName));
  assert.match(entry.icon_url, ICON_ASSET_URL_PATTERN);
  const fakeEntry = buildCatalogEntry(manifest, { sha256: "0", sizeBytes: 1 }, undefined, () => ({ assetName: "icon-meta-api-0123456789ab.svg" }));
  assert.equal(fakeEntry.icon_url, "https://github.com/BimaPangestu28/graphrt-plugins/releases/download/catalog/icon-meta-api-0123456789ab.svg");
  assert.throws(() => buildCatalogEntry(manifest, { sha256: "0", sizeBytes: 1 }, undefined, () => {
    throw new Error("meta-api: no icon.svg");
  }), /no icon\.svg/);
});

test("the full catalog with icon URLs stays under the desktop app's size limit", () => {
  const catalogEntries = listPluginNames().map((pluginName) => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, pluginName, "graphrt-plugin.json"), "utf8"));
    return buildCatalogEntry(manifest, { sha256: "f".repeat(64), sizeBytes: 1_000_000, readmeText: readFileSync(join(REPO_ROOT, pluginName, "README.md"), "utf8") });
  });
  const catalogText = renderCatalogText(buildCatalog(catalogEntries, new Date()));
  // renderCatalogText already refuses more than MAX_CATALOG_BYTES; the icon URLs add about 110 bytes per plugin.
  assert.ok(Buffer.byteLength(catalogText) <= MAX_CATALOG_BYTES, `catalog is ${Buffer.byteLength(catalogText)} bytes`);
  assert.equal(catalogText.includes("<svg"), false, "icons are linked, never inlined");
  for (const entry of catalogEntries) assert.match(entry.icon_url, ICON_ASSET_URL_PATTERN, entry.name);
  assert.equal(new Set(catalogEntries.map((entry) => entry.icon_url)).size, catalogEntries.length, "icon URLs are unique per plugin");
});

test("stages each catalog icon under its asset name and lists it in SHA256SUMS", () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "catalog-icons-"));
  try {
    const released = ["meta-api", "open-meteo"].map((pluginName) => {
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, pluginName, "graphrt-plugin.json"), "utf8"));
      return { tarballName: `${pluginName}-${manifest.version}.tar.gz`, sha256: "a".repeat(64), manifest, catalogEntry: buildCatalogEntry(manifest, { sha256: "a".repeat(64), sizeBytes: 1 }) };
    });
    const { indexPath, sumsPath, iconPaths } = writeCatalogFiles(outputDirectory, released);
    const catalog = JSON.parse(readFileSync(indexPath, "utf8"));
    const sums = readFileSync(sumsPath, "utf8");
    assert.equal(iconPaths.length, 2);
    for (const [index, catalogEntry] of catalog.plugins.entries()) {
      const icon = readPluginIcon(catalogEntry.name);
      assert.ok(catalogEntry.icon_url.endsWith(`/${icon.assetName}`));
      assert.deepEqual(readFileSync(join(outputDirectory, "icons", icon.assetName)), icon.bytes);
      assert.ok(sums.includes(`${icon.sha256}  ${icon.assetName}\n`), icon.assetName);
      assert.ok(iconPaths[index].endsWith(icon.assetName));
    }
    assert.deepEqual(readdirSync(join(outputDirectory, "icons")).sort(), iconPaths.map((iconPath) => iconPath.split("/").at(-1)).sort());
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});
