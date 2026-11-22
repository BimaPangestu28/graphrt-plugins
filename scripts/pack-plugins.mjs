/**
 * Packs plugins into release tarballs with pinned checksums, plus a catalog.
 *
 * Usage: node scripts/pack-plugins.mjs [plugin-name...] [--out <dir>]
 *        node scripts/pack-plugins.mjs --plugin-dir <dir> [--out <dir>]
 *   plugin-name   plugins to pack (default: every plugin directory)
 *   --out         output directory (default: dist)
 *   --plugin-dir  pack one plugin from any git-tracked directory (a community plugin in its own repository):
 *                 writes only `<out>/<name>-<version>.tar.gz`, with its root icon.svg, and prints its sha256
 *
 * Writes `<out>/<name>-<version>.tar.gz` per plugin, `<out>/index.json` (the v1
 * catalog for the packed plugins, with release download URLs), `<out>/index-v2.json`
 * (the slim v2 index), `<out>/details/` (one `plugin-<name>-<version>.json` per plugin),
 * `<out>/icons/` (each plugin's icon under its `catalog` release asset name) and
 * `<out>/SHA256SUMS`. publish-plugins.mjs rebuilds the catalog from the published
 * assets, so it always describes what was actually released.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { basename, join, resolve } from "node:path";
import { REPO_ROOT } from "./plugins.mjs";
import {
  COMMUNITY_SOURCE, MANIFEST_FILE_NAME, MAX_CATALOG_BYTES, buildCatalog, buildCatalogEntry, formatSha256Sums, listPluginNames, packPlugin,
  renderCatalogTextWithinLimit, sha256Hex, stripCatalogEntrySchemas,
} from "./lib/plugin-package.mjs";
import {
  CATALOG_V2_INDEX_NAME, MAX_CATALOG_V2_BYTES, buildCatalogV2, buildCatalogV2Entry, buildPluginDetail, renderCatalogV2Text, renderPluginDetail,
} from "./lib/catalog-v2.mjs";
import { readPluginIcon } from "./lib/plugin-icons.mjs";

/** Sub-directory of the catalog output that holds the icons to upload as `catalog` release assets. */
export const ICON_STAGING_DIRECTORY_NAME = "icons";
/** Sub-directory of the catalog output that holds the v2 detail files to upload as `catalog` release assets. */
export const DETAIL_STAGING_DIRECTORY_NAME = "details";

/**
 * Parses command line arguments.
 *
 * @param argumentList - process.argv without node and the script (string[])
 * @returns `{pluginNames, outputDirectory, pluginDirectory}`; pluginDirectory is null unless --plugin-dir is given (object)
 * @throws Error - On an unknown plugin name or option
 */
export function parsePackArguments(argumentList) {
  const knownPlugins = listPluginNames();
  let outputDirectory = resolve(REPO_ROOT, "dist");
  let pluginDirectory = null;
  const pluginNames = [];
  for (let index = 0; index < argumentList.length; index += 1) {
    const argument = argumentList[index];
    if (argument === "--out") {
      outputDirectory = resolve(argumentList[++index] ?? "");
    } else if (argument === "--plugin-dir") {
      pluginDirectory = resolve(argumentList[++index] ?? "");
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown option ${argument}`);
    } else if (!knownPlugins.includes(argument)) {
      throw new Error(`unknown plugin \`${argument}\` (known: ${knownPlugins.join(", ")})`);
    } else {
      pluginNames.push(argument);
    }
  }
  if (pluginDirectory && pluginNames.length > 0) throw new Error("--plugin-dir packs one directory; do not also name plugins");
  return { pluginNames: pluginNames.length > 0 ? pluginNames : knownPlugins, outputDirectory, pluginDirectory };
}

/**
 * Packs one plugin that lives outside this repo (a community plugin) the way official plugins are packed, with
 * its root icon.svg included. No catalog files are written.
 *
 * @param pluginDirectory - The plugin's directory, tracked by git (string)
 * @param outputDirectory - Where `<name>-<version>.tar.gz` is written (string)
 * @param options - Packing options
 * @param options.commandEnvironment - Environment of git and npm (object, default: process.env)
 * @returns As packPlugin (object)
 * @throws Error - When the manifest, the files or npm fail the packing checks
 */
export function packExternalPlugin(pluginDirectory, outputDirectory, { commandEnvironment = process.env } = {}) {
  const { name: pluginName } = JSON.parse(readFileSync(join(pluginDirectory, MANIFEST_FILE_NAME), "utf8"));
  if (typeof pluginName !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginName)) throw new Error(`${pluginDirectory}: manifest name \`${pluginName}\` is not a valid plugin name`);
  mkdirSync(outputDirectory, { recursive: true });
  const packed = packPlugin(pluginName, { outputDirectory, sourceDirectory: pluginDirectory, includeIcon: true, commandEnvironment });
  rmSync(resolve(outputDirectory, ".staging"), { recursive: true, force: true });
  return packed;
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
 * Byte sizes of the catalog files for a set of plugins, as writeCatalogFiles would render them.
 *
 * @param releasedPlugins - As for writeCatalogFiles (object[])
 * @param generatedAt - Generation time (Date)
 * @returns `{v1FullBytes, v1StrippedBytes, v2Bytes}` (object)
 */
export function measureCatalogSizes(releasedPlugins, generatedAt) {
  const catalogEntries = releasedPlugins.map(({ catalogEntry }) => catalogEntry);
  const v2Entries = releasedPlugins.map(({ manifest, catalogEntry }) => buildCatalogV2Entry(catalogEntry, renderPluginDetail(buildPluginDetail(manifest))));
  const renderedBytes = (document) => Buffer.byteLength(`${JSON.stringify(document)}\n`);
  return {
    v1FullBytes: renderedBytes(buildCatalog(catalogEntries, generatedAt)),
    v1StrippedBytes: renderedBytes(buildCatalog(catalogEntries.map((entry) => stripCatalogEntrySchemas(entry)), generatedAt)),
    v2Bytes: renderedBytes(buildCatalogV2(v2Entries, generatedAt)),
  };
}

/**
 * Keeps community plugins out of the catalog, largest first, until index.json and index-v2.json fit, so that
 * community size never fails the official publish and never strips official node schemas: when the official
 * plugins alone fit index.json with schemas, the kept plugins do too. Official plugins are always kept.
 *
 * @param releasedPlugins - As for writeCatalogFiles (object[])
 * @param options - Limits
 * @param options.generatedAt - Generation time (Date)
 * @param options.maxV1Bytes - index.json limit (number, default MAX_CATALOG_BYTES)
 * @param options.maxV2Bytes - index-v2.json limit (number, default MAX_CATALOG_V2_BYTES)
 * @returns `{kept, dropped}`; dropped holds `{name, source: "community", reason}` (object)
 */
export function fitCommunityPluginsIntoCatalog(releasedPlugins, { generatedAt, maxV1Bytes = MAX_CATALOG_BYTES, maxV2Bytes = MAX_CATALOG_V2_BYTES }) {
  const isCommunity = ({ catalogEntry }) => catalogEntry.source === COMMUNITY_SOURCE;
  if (!releasedPlugins.some(isCommunity)) return { kept: releasedPlugins, dropped: [] };
  const officialPlugins = releasedPlugins.filter((released) => !isCommunity(released));
  const officialNeedsStripping = measureCatalogSizes(officialPlugins, generatedAt).v1FullBytes > maxV1Bytes;
  const entryBytes = ({ catalogEntry }) => Buffer.byteLength(JSON.stringify(officialNeedsStripping ? stripCatalogEntrySchemas(catalogEntry) : catalogEntry));
  let communityPlugins = releasedPlugins.filter(isCommunity).sort((left, right) => entryBytes(right) - entryBytes(left));
  const dropped = [];
  while (communityPlugins.length > 0) {
    const overflow = findCatalogOverflow(measureCatalogSizes([...officialPlugins, ...communityPlugins], generatedAt), { officialNeedsStripping, maxV1Bytes, maxV2Bytes });
    if (!overflow) break;
    const [largest, ...rest] = communityPlugins;
    dropped.push({ name: largest.catalogEntry.name, source: COMMUNITY_SOURCE, reason: `left out of this catalog: ${overflow} (largest community entries are dropped first)` });
    communityPlugins = rest;
  }
  const keptNames = new Set([...officialPlugins, ...communityPlugins].map(({ catalogEntry }) => catalogEntry.name));
  return { kept: releasedPlugins.filter(({ catalogEntry }) => keptNames.has(catalogEntry.name)), dropped };
}

function findCatalogOverflow(sizes, { officialNeedsStripping, maxV1Bytes, maxV2Bytes }) {
  const v1Bytes = officialNeedsStripping ? sizes.v1StrippedBytes : sizes.v1FullBytes;
  if (v1Bytes > maxV1Bytes) return `index.json would exceed ${maxV1Bytes} bytes`;
  if (sizes.v2Bytes > maxV2Bytes) return `${CATALOG_V2_INDEX_NAME} would exceed ${maxV2Bytes} bytes`;
  return null;
}

/**
 * Writes the catalog files into a directory: `index.json` (v1), `index-v2.json`, the detail files it links
 * (in `details/`), the icons both indexes name (in `icons/`, under their release asset names) and
 * `SHA256SUMS` (tarballs, icons, detail files and both indexes). v1 is written without node schemas when
 * the full one would exceed MAX_CATALOG_BYTES; that and an index-v2.json above its warning size are logged.
 *
 * @param outputDirectory - Target directory (string)
 * @param releasedPlugins - `{tarballName, sha256, manifest, catalogEntry, icon?}` per plugin; `manifest` is the released
 *   manifest the detail file is derived from; `icon` (`{assetName, bytes, sha256}`) is set for community plugins,
 *   whose icon is not in this repo (object[])
 * @param options - Options
 * @param options.maxV1Bytes - index.json limit for fitCommunityPluginsIntoCatalog (number, default: the desktop app's)
 * @param options.maxV2Bytes - index-v2.json limit (number, default: the desktop app's)
 * @param options.signIndexes - Signs the written indexes before SHA256SUMS is written: `([{path, name, catalog}]) ->
 *   signature paths` (function, default: no signatures; publish-plugins.mjs passes catalog-signing.mjs)
 * @returns `{indexPath, indexV2Path, sumsPath, signaturePaths, iconPaths, detailFiles, v1WithoutSchemas, skipped}`;
 *   detailFiles holds `{assetName, sha256, sizeBytes, stagedPath}`; skipped lists the community plugins left out
 *   to fit (object)
 * @throws Error - When a plugin has no valid icon.svg or manifest, the official plugins alone are too large, or
 *   signing fails
 */
export function writeCatalogFiles(outputDirectory, allReleasedPlugins, { signIndexes = () => [], ...limits } = {}) {
  const generatedAt = new Date();
  const { kept: releasedPlugins, dropped } = fitCommunityPluginsIntoCatalog(allReleasedPlugins, { generatedAt, ...limits });
  dropped.forEach(({ name, reason }) => console.error(`community ${name}: ${reason}`));
  const v1Catalog = renderCatalogTextWithinLimit(buildCatalog(releasedPlugins.map((released) => released.catalogEntry), generatedAt), limits.maxV1Bytes);
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
  const signaturePaths = signIndexes([
    { path: indexV2Path, name: CATALOG_V2_INDEX_NAME, catalog: JSON.parse(v2Catalog.catalogText) },
    { path: indexPath, name: "index.json", catalog: JSON.parse(v1Catalog.catalogText) },
  ]);
  const fileHashes = releasedPlugins.map(({ tarballName, sha256 }) => ({ fileName: tarballName, sha256 }));
  fileHashes.push(...[...icons, ...detailFiles].map(({ assetName, sha256 }) => ({ fileName: assetName, sha256 })));
  fileHashes.push({ fileName: "index.json", sha256: sha256Hex(Buffer.from(v1Catalog.catalogText)) });
  fileHashes.push({ fileName: CATALOG_V2_INDEX_NAME, sha256: sha256Hex(Buffer.from(v2Catalog.catalogText)) });
  fileHashes.push(...signaturePaths.map((signaturePath) => ({ fileName: basename(signaturePath), sha256: sha256Hex(readFileSync(signaturePath)) })));
  writeFileSync(sumsPath, formatSha256Sums(fileHashes));
  const iconPaths = icons.map(({ stagedPath }) => stagedPath);
  return { indexPath, indexV2Path, sumsPath, signaturePaths, iconPaths, detailFiles, v1WithoutSchemas: v1Catalog.withoutSchemas, skipped: dropped };
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

/**
 * Copies each plugin's icon to `<iconDirectory>/<asset name>`, replacing anything staged before. Official icons
 * come from the repo; community items carry theirs (`icon`, taken from the tarball or the neutral fallback).
 */
function stageCatalogIcons(iconDirectory, releasedPlugins) {
  rmSync(iconDirectory, { recursive: true, force: true });
  mkdirSync(iconDirectory, { recursive: true });
  return releasedPlugins.map(({ catalogEntry, icon: carriedIcon }) => {
    const icon = carriedIcon ?? readPluginIcon(catalogEntry.name);
    if (!catalogEntry.icon_url.endsWith(`/${icon.assetName}`)) throw new Error(`${catalogEntry.name}: icon.svg changed while the catalog was built`);
    const stagedPath = resolve(iconDirectory, icon.assetName);
    writeFileSync(stagedPath, icon.bytes);
    return { ...icon, stagedPath };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { pluginNames, outputDirectory, pluginDirectory } = parsePackArguments(process.argv.slice(2));
    const packedPlugins = pluginDirectory ? [packExternalPlugin(pluginDirectory, outputDirectory)] : packPlugins(pluginNames, outputDirectory);
    for (const packed of packedPlugins) {
      console.log(`${packed.sha256}  ${packed.tarballName}  (${packed.sizeBytes} bytes, ${Object.keys(packed.manifest.checksums).length} pinned files)`);
    }
  } catch (error) {
    console.error(`pack-plugins: ${error.message}`);
    process.exit(1);
  }
}
