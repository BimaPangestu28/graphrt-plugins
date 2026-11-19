/**
 * Writes the maturity labels from plugin-status.json into the root README plugin
 * table (Status and ToS risk columns) and into the status line of each plugin README.
 *
 * Usage: node scripts/sync-plugin-status.mjs [--check]
 *   --check  exit 1 instead of writing when anything is out of date or invalid
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./plugins.mjs";
import { README_FILE_NAME, listPluginNames } from "./lib/plugin-package.mjs";
import { applyReadmeStatusLine, applyStatusColumns, findPluginStatusProblems, readPluginStatuses } from "./lib/plugin-status.mjs";

const isCheckMode = process.argv.includes("--check");

/**
 * Rewrites one file when its derived text differs.
 *
 * @param filePath - File to update (string)
 * @param deriveText - Maps the current text to the wanted text (function)
 * @returns True when the file was (or, in check mode, would be) changed (boolean)
 */
function updateFile(filePath, deriveText) {
  const currentText = readFileSync(filePath, "utf8");
  const wantedText = deriveText(currentText);
  if (wantedText === currentText) return false;
  if (!isCheckMode) writeFileSync(filePath, wantedText);
  return true;
}

const pluginStatuses = readPluginStatuses();
const problems = findPluginStatusProblems(pluginStatuses, listPluginNames());
if (problems.length > 0) {
  console.error(`plugin-status.json is invalid:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

const staleFiles = [];
const rootReadmePath = join(REPO_ROOT, README_FILE_NAME);
if (updateFile(rootReadmePath, (readmeText) => applyStatusColumns(readmeText, pluginStatuses))) staleFiles.push(README_FILE_NAME);
for (const pluginName of listPluginNames()) {
  const readmePath = join(REPO_ROOT, pluginName, README_FILE_NAME);
  if (updateFile(readmePath, (readmeText) => applyReadmeStatusLine(readmeText, pluginStatuses[pluginName]))) staleFiles.push(`${pluginName}/${README_FILE_NAME}`);
}

if (isCheckMode && staleFiles.length > 0) {
  console.error(`Status labels out of date (run \`npm run sync\`):\n  ${staleFiles.join("\n  ")}`);
  process.exit(1);
}
console.error(isCheckMode ? "All status labels are in sync." : `Synced status labels (${staleFiles.length} file(s) changed).`);
