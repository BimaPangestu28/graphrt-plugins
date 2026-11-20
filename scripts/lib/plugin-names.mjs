/**
 * Display names for the plugins (`plugin-names.json`), e.g. `currency-rates` → "Currency Rates",
 * `github` → "GitHub". They are curated, not derived, so brand spelling stays right. The release
 * catalog carries them as `display_name`; the technical name stays the identifier everywhere else.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../plugins.mjs";

export const PLUGIN_NAMES_FILE_NAME = "plugin-names.json";
/** Longest display name the desktop app accepts. */
export const MAX_DISPLAY_NAME_LENGTH = 60;
let cachedDisplayNames = null;

/**
 * Reads `plugin-names.json` (cached).
 *
 * @returns Plugin name to display name (object)
 * @throws Error - When the file is missing or not valid JSON
 */
export function readPluginDisplayNames() {
  cachedDisplayNames ??= JSON.parse(readFileSync(join(REPO_ROOT, PLUGIN_NAMES_FILE_NAME), "utf8"));
  return cachedDisplayNames;
}

/**
 * The display name of one plugin.
 *
 * @param pluginName - Technical plugin name (string)
 * @returns Display name (string)
 * @throws Error - When the plugin has no entry, so a new plugin cannot ship without one
 */
export function displayNameFor(pluginName) {
  const displayName = readPluginDisplayNames()[pluginName];
  if (typeof displayName !== "string") throw new Error(`${pluginName}: no entry in ${PLUGIN_NAMES_FILE_NAME}`);
  return displayName;
}
