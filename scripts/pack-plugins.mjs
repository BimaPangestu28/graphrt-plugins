/**
 * Packs plugins into release tarballs with pinned checksums, plus a catalog.
 *
 * Usage: node scripts/pack-plugins.mjs [plugin-name...] [--out <dir>]
 *   plugin-name  plugins to pack (default: every plugin directory)
 *   --out        output directory (default: dist)
 *
 * Writes `<out>/<name>-<version>.tar.gz` per plugin, `<out>/index.json` (the v1
 * catalog for the packed plugins, with release download URLs), `<out>/index-v2.json`
 * (the slim v2 index), `<out>/details/` (one `plugin-<name>-<version>.json` per plugin),
 * `<out>/icons/` (each plugin's icon under its `catalog` release asset name) and
 * `<out>/SHA256SUMS`. publish-plugins.mjs rebuilds the catalog from the published
 * assets, so it always describes what was actually released.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { REPO_ROOT } from "./plugins.mjs";
import {
  MAX_CATALOG_BYTES, buildCatalog, buildCatalogEntry, formatSha256Sums, listPluginNames, packPlugin, renderCatalogTextWithinLimit, sha256Hex,
} from "./lib/plugin-package.mjs";
import { CATALOG_V2_INDEX_NAME, buildCatalogV2, buildCatalogV2Entry, buildPluginDetail, renderCatalogV2Text, renderPluginDetail } from "./lib/catalog-v2.mjs";
import { readPluginIcon } from "./lib/plugin-icons.mjs";

/** Sub-directory of the catalog output that holds the icons to upload as `catalog` release assets. */
export const ICON_STAGING_DIRECTORY_NAME = "icons";
/** Sub-directory of the catalog output that holds the v2 detail files to upload as `catalog` release assets. */
export const DETAIL_STAGING_DIRECTORY_NAME = "details";

/**
 * Parses command line arguments.
 *
 * @param argumentList - process.argv without node and the script (string[])
 * @returns `{pluginNames, outputDirectory}` (object)
 * @throws Error - On an unknown plugin name or option
 */
export function parsePackArguments(argumentList) {
  const knownPlugins = listPluginNames();
  let outputDirectory = resolve(REPO_ROOT, "dist");
  const pluginNames = [];
  for (let index = 0; index < argumentList.length; index += 1) {
    const argument = argumentList[index];
    if (argument === "--out") {
      outputDirectory = resolve(argumentList[++index] ?? "");
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown option ${argument}`);
    } else if (!knownPlugins.includes(argument)) {
      throw new Error(`unknown plugin \`${argument}\` (known: ${knownPlugins.join(", ")})`);
    } else {
      pluginNames.push(argument);
    }
  }
  return { pluginNames: pluginNames.length > 0 ? pluginNames : knownPlugins, outputDirectory };
}

/**
 * Packs the given plugins and writes the catalog files (writeCatalogFiles) next to them.
 *
 * @param pluginNames - Plugins to pack (string[])
 * @param outputDirectory - Output directory (string)
 * @returns Packed plugin descriptions from packPlugin (object[])
 */
export function packPlugins(pluginNames, outputDirectory) {
  mkdirSync(outputDirectory, { recursive: true });
  const packedPlugins = pluginNames.map((pluginName) => {
    console.error(`packing ${pluginName}`);
    return packPlugin(pluginName, { outputDirectory });
  });
  rmSync(resolve(outputDirectory, ".staging"), { recursive: true, force: true });
  writeCatalogFiles(outputDirectory, packedPlugins.map((packed) => ({ ...packed, catalogEntry: buildCatalogEntry(packed.manifest, packed) })));
  return packedPlugins;
}

/**
 * Writes the catalog files into a directory: `index.json` (v1), `index-v2.json`, the detail files it links
 * (in `details/`), the icons both indexes name (in `icons/`, under their release asset names) and
 * `SHA256SUMS` (tarballs, icons, detail files and both indexes). v1 is written without node schemas when
 * the full one would exceed MAX_CATALOG_BYTES; that and an index-v2.json above its warning size are logged.
 *
 * @param outputDirectory - Target directory (string)
 * @param releasedPlugins - `{tarballName, sha256, manifest, catalogEntry}` per plugin; `manifest` is the released
 *   manifest the detail file is derived from (object[])
 * @returns `{indexPath, indexV2Path, sumsPath, iconPaths, detailFiles, v1WithoutSchemas}`; detailFiles holds
 *   `{assetName, sha256, sizeBytes, stagedPath}` (object)
 * @throws Error - When a plugin has no valid icon.svg or manifest, or a catalog file is too large
 */
export function writeCatalogFiles(outputDirectory, releasedPlugins) {
  const generatedAt = new Date();
  const v1Catalog = renderCatalogTextWithinLimit(buildCatalog(releasedPlugins.map((released) => released.catalogEntry), generatedAt));
  if (v1Catalog.withoutSchemas) console.error(`warning: index.json would be ${v1Catalog.fullSizeBytes} bytes (limit ${MAX_CATALOG_BYTES}); written without node config_schema/outputs (they are in the v2 detail files)`);
  const detailFiles = stageDetailFiles(resolve(outputDirectory, DETAIL_STAGING_DIRECTORY_NAME), releasedPlugins);
  const v2Entries = releasedPlugins.map(({ catalogEntry }, index) => buildCatalogV2Entry(catalogEntry, detailFiles[index]));
  const v2Catalog = renderCatalogV2Text(buildCatalogV2(v2Entries, generatedAt));
  if (v2Catalog.warning) console.error(`warning: ${v2Catalog.warning}`);
  const icons = stageCatalogIcons(resolve(outputDirectory, ICON_STAGING_DIRECTORY_NAME), releasedPlugins);
  const indexPath = resolve(outputDirectory, "index.json");
  const indexV2Path = resolve(outputDirectory, CATALOG_V2_INDEX_NAME);
  const sumsPath = resolve(outputDirectory, "SHA256SUMS");
  writeFileSync(indexPath, v1Catalog.catalogText);
  writeFileSync(indexV2Path, v2Catalog.catalogText);
  const fileHashes = releasedPlugins.map(({ tarballName, sha256 }) => ({ fileName: tarballName, sha256 }));
  fileHashes.push(...[...icons, ...detailFiles].map(({ assetName, sha256 }) => ({ fileName: assetName, sha256 })));
  fileHashes.push({ fileName: "index.json", sha256: sha256Hex(Buffer.from(v1Catalog.catalogText)) });
  fileHashes.push({ fileName: CATALOG_V2_INDEX_NAME, sha256: sha256Hex(Buffer.from(v2Catalog.catalogText)) });
  writeFileSync(sumsPath, formatSha256Sums(fileHashes));
  const iconPaths = icons.map(({ stagedPath }) => stagedPath);
  return { indexPath, indexV2Path, sumsPath, iconPaths, detailFiles, v1WithoutSchemas: v1Catalog.withoutSchemas };
}

/** Writes each plugin's detail file to `<detailDirectory>/<asset name>`, replacing anything staged before. */
function stageDetailFiles(detailDirectory, releasedPlugins) {
  rmSync(detailDirectory, { recursive: true, force: true });
  mkdirSync(detailDirectory, { recursive: true });
  return releasedPlugins.map(({ manifest, catalogEntry }) => {
    if (manifest?.name !== catalogEntry.name || manifest.version !== catalogEntry.version) {
      throw new Error(`${catalogEntry.name}: the released manifest is needed to build its detail file`);
    }
    const { bytes, ...detailFile } = renderPluginDetail(buildPluginDetail(manifest));
    const stagedPath = resolve(detailDirectory, detailFile.assetName);
    writeFileSync(stagedPath, bytes);
    return { ...detailFile, stagedPath };
  });
}

/** Copies each plugin's icon to `<iconDirectory>/<asset name>`, replacing anything staged before. */
function stageCatalogIcons(iconDirectory, releasedPlugins) {
  rmSync(iconDirectory, { recursive: true, force: true });
  mkdirSync(iconDirectory, { recursive: true });
  return releasedPlugins.map(({ catalogEntry }) => {
    const icon = readPluginIcon(catalogEntry.name);
    if (!catalogEntry.icon_url.endsWith(`/${icon.assetName}`)) throw new Error(`${catalogEntry.name}: icon.svg changed while the catalog was built`);
    const stagedPath = resolve(iconDirectory, icon.assetName);
    writeFileSync(stagedPath, icon.bytes);
    return { ...icon, stagedPath };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { pluginNames, outputDirectory } = parsePackArguments(process.argv.slice(2));
    for (const packed of packPlugins(pluginNames, outputDirectory)) {
      console.log(`${packed.sha256}  ${packed.tarballName}  (${packed.sizeBytes} bytes, ${Object.keys(packed.manifest.checksums).length} pinned files)`);
    }
  } catch (error) {
    console.error(`pack-plugins: ${error.message}`);
    process.exit(1);
  }
}
