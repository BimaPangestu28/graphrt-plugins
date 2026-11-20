/**
 * Packs plugins into release tarballs with pinned checksums, plus a catalog.
 *
 * Usage: node scripts/pack-plugins.mjs [plugin-name...] [--out <dir>]
 *   plugin-name  plugins to pack (default: every plugin directory)
 *   --out        output directory (default: dist)
 *
 * Writes `<out>/<name>-<version>.tar.gz` per plugin, `<out>/index.json` (the
 * catalog for the packed plugins, with release download URLs), `<out>/icons/`
 * (each plugin's icon under its `catalog` release asset name) and
 * `<out>/SHA256SUMS`. publish-plugins.mjs rebuilds index.json from the published
 * assets, so the catalog always describes what was actually released.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { REPO_ROOT } from "./plugins.mjs";
import { buildCatalog, buildCatalogEntry, formatSha256Sums, listPluginNames, packPlugin, renderCatalogText, sha256Hex } from "./lib/plugin-package.mjs";
import { readPluginIcon } from "./lib/plugin-icons.mjs";

/** Sub-directory of the catalog output that holds the icons to upload as `catalog` release assets. */
export const ICON_STAGING_DIRECTORY_NAME = "icons";

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
 * Packs the given plugins and writes index.json and SHA256SUMS next to them.
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
 * Writes `index.json`, the icons its `icon_url`s name (in `icons/`, under their release asset
 * names) and `SHA256SUMS` (tarballs, icons and index.json) into a directory.
 *
 * @param outputDirectory - Target directory (string)
 * @param releasedPlugins - `{tarballName, sha256, catalogEntry}` per plugin (object[])
 * @returns `{indexPath, sumsPath, iconPaths}` (object)
 * @throws Error - When a plugin has no valid icon.svg, or the catalog is too large
 */
export function writeCatalogFiles(outputDirectory, releasedPlugins) {
  const catalogText = renderCatalogText(buildCatalog(releasedPlugins.map((released) => released.catalogEntry), new Date()));
  const indexPath = resolve(outputDirectory, "index.json");
  const sumsPath = resolve(outputDirectory, "SHA256SUMS");
  const icons = stageCatalogIcons(resolve(outputDirectory, ICON_STAGING_DIRECTORY_NAME), releasedPlugins);
  writeFileSync(indexPath, catalogText);
  const fileHashes = releasedPlugins.map(({ tarballName, sha256 }) => ({ fileName: tarballName, sha256 }));
  fileHashes.push(...icons.map(({ assetName, sha256 }) => ({ fileName: assetName, sha256 })));
  fileHashes.push({ fileName: "index.json", sha256: sha256Hex(Buffer.from(catalogText)) });
  writeFileSync(sumsPath, formatSha256Sums(fileHashes));
  return { indexPath, sumsPath, iconPaths: icons.map(({ stagedPath }) => stagedPath) };
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
