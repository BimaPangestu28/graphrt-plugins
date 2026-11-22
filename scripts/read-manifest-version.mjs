/**
 * Prints the `version` of one plugin's graphrt-plugin.json, for the release workflow (which compares it with the
 * pushed tag). The plugin name comes from a git tag, so it is validated and the manifest is read with fs: nothing
 * is interpolated into code.
 *
 * Usage: node scripts/read-manifest-version.mjs <plugin-name>
 *   exit 0 and the version on stdout, or exit 1 and an error on stderr
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./plugins.mjs";

const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Reads a plugin's manifest version.
 *
 * @param pluginName - Plugin directory name (string)
 * @param repositoryRoot - Repository root (string, default: this repo)
 * @returns The version (string)
 * @throws Error - When the name is not a plugin name, or the manifest is missing, invalid or has no string version
 */
export function readManifestVersion(pluginName, repositoryRoot = REPO_ROOT) {
  if (typeof pluginName !== "string" || !PLUGIN_NAME_PATTERN.test(pluginName)) throw new Error(`\`${pluginName}\` is not a plugin name (${PLUGIN_NAME_PATTERN.source})`);
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, pluginName, "graphrt-plugin.json"), "utf8"));
  if (typeof manifest.version !== "string" || manifest.version === "") throw new Error(`${pluginName}/graphrt-plugin.json has no version`);
  return manifest.version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: node scripts/read-manifest-version.mjs <plugin-name>");
    console.log(readManifestVersion(process.argv[2]));
  } catch (error) {
    console.error(`read-manifest-version: ${error.message}`);
    process.exit(1);
  }
}
