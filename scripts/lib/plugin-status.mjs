/**
 * Maturity labels for the plugins, kept in the repo's own catalog data
 * (`plugin-status.json`) rather than in the plugin manifests.
 *
 * Each entry is `{status, reason, tos_risk, tos_notes?}`:
 * - `status`: `stable` (verified end to end with real use), `beta` (official API,
 *   reviewed, checked live only with invalid credentials) or `experimental`
 *   (unofficial access, scraping, ToS-risky automation, or key parts unverified).
 * - `tos_risk`: `none`, `low`, `medium` or `high`; `docs/tos-audit.md` explains each
 *   rating, and `medium`/`high` entries must carry `tos_notes`.
 *
 * The same data feeds the root README table, the status line in each plugin README
 * and the `status`/`tos_risk` fields of the release catalog (`index.json`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../plugins.mjs";

export const PLUGIN_STATUS_FILE_NAME = "plugin-status.json";
export const PLUGIN_STATUS_LEVELS = ["stable", "beta", "experimental"];
export const TOS_RISK_LEVELS = ["none", "low", "medium", "high"];

const ENTRY_FIELDS = new Set(["status", "reason", "tos_risk", "tos_notes"]);
const RISKS_NEEDING_NOTES = new Set(["medium", "high"]);
const STATUS_LINE_PREFIX = "**Status:**";
const TABLE_ROW_PATTERN = /^\| \[([a-z0-9-]+)\]\(\1\/\) \|/;
const cachedStatusFiles = new Map();

/**
 * Reads `plugin-status.json` (cached per path).
 *
 * @param statusFilePath - File to read (string, default: the repo root file)
 * @returns Plugin name to status entry (object)
 * @throws Error - When the file is missing or not valid JSON
 */
export function readPluginStatuses(statusFilePath = join(REPO_ROOT, PLUGIN_STATUS_FILE_NAME)) {
  if (!cachedStatusFiles.has(statusFilePath)) {
    cachedStatusFiles.set(statusFilePath, JSON.parse(readFileSync(statusFilePath, "utf8")));
  }
  return cachedStatusFiles.get(statusFilePath);
}

/**
 * Lists every problem in a status map: missing or unknown plugins and invalid entries.
 *
 * @param pluginStatuses - Plugin name to status entry (object)
 * @param pluginNames - Plugin directories in the repo (string[])
 * @returns Human-readable problems; empty when the map is valid (string[])
 */
export function findPluginStatusProblems(pluginStatuses, pluginNames) {
  const knownPlugins = new Set(pluginNames);
  const problems = pluginNames.filter((pluginName) => !Object.hasOwn(pluginStatuses, pluginName)).map((pluginName) => `${pluginName}: missing from ${PLUGIN_STATUS_FILE_NAME}`);
  for (const [pluginName, statusEntry] of Object.entries(pluginStatuses)) {
    if (!knownPlugins.has(pluginName)) {
      problems.push(`${pluginName}: no such plugin directory`);
      continue;
    }
    problems.push(...findEntryProblems(pluginName, statusEntry));
  }
  return problems;
}

/** Validates one entry's fields. */
function findEntryProblems(pluginName, statusEntry) {
  const problems = findStatusFieldProblems(pluginName, statusEntry);
  for (const fieldName of Object.keys(statusEntry)) {
    if (!ENTRY_FIELDS.has(fieldName)) problems.push(`${pluginName}: unknown field \`${fieldName}\``);
  }
  return problems;
}

/**
 * Checks the maturity fields shared by plugin-status.json and community-plugins.json: a known `status`, a
 * non-empty `reason`, a known `tos_risk`, and `tos_notes` when the risk is `medium` or `high`.
 *
 * @param label - Prefix of each message, usually the plugin name (string)
 * @param statusFields - `{status, reason, tos_risk, tos_notes?}` (object)
 * @returns Human-readable problems; empty when the fields are valid (string[])
 */
export function findStatusFieldProblems(label, { status, reason, tos_risk: tosRisk, tos_notes: tosNotes }) {
  const problems = [];
  if (!PLUGIN_STATUS_LEVELS.includes(status)) problems.push(`${label}: status \`${status}\` must be one of ${PLUGIN_STATUS_LEVELS.join(", ")}`);
  if (typeof reason !== "string" || reason.trim() === "") problems.push(`${label}: reason must be a non-empty string`);
  if (!TOS_RISK_LEVELS.includes(tosRisk)) problems.push(`${label}: tos_risk \`${tosRisk}\` must be one of ${TOS_RISK_LEVELS.join(", ")}`);
  const hasNotes = typeof tosNotes === "string" && tosNotes.trim() !== "";
  if (RISKS_NEEDING_NOTES.has(tosRisk) && !hasNotes) problems.push(`${label}: tos_risk ${tosRisk} needs tos_notes`);
  return problems;
}

/**
 * Returns one plugin's status entry.
 *
 * @param pluginStatuses - Plugin name to status entry (object)
 * @param pluginName - Plugin directory name (string)
 * @returns The entry (object)
 * @throws Error - When the plugin has no entry
 */
export function statusForPlugin(pluginStatuses, pluginName) {
  if (!Object.hasOwn(pluginStatuses, pluginName)) throw new Error(`${pluginName}: no entry in ${PLUGIN_STATUS_FILE_NAME}`);
  return pluginStatuses[pluginName];
}

/**
 * Formats the status line shown under a plugin README's title.
 *
 * @param statusEntry - The plugin's status entry (object)
 * @returns One markdown line (string)
 */
export function formatReadmeStatusLine({ status, tos_risk: tosRisk, reason }) {
  return `${STATUS_LINE_PREFIX} ${status} · **ToS risk:** ${tosRisk}. ${reason.trim()} See [plugin status](../README.md#plugin-status).`;
}

/**
 * Puts the status line right under the README's `# title` (replacing an existing one).
 *
 * @param readmeText - Plugin README markdown (string)
 * @param statusEntry - The plugin's status entry (object)
 * @returns The README with exactly one status line (string)
 * @throws Error - When the README does not start with a title line
 */
export function applyReadmeStatusLine(readmeText, statusEntry) {
  const readmeLines = readmeText.split("\n");
  if (!readmeLines[0].startsWith("# ")) throw new Error("plugin README must start with a `# ` title line");
  const statusLine = formatReadmeStatusLine(statusEntry);
  if (readmeLines[2]?.startsWith(STATUS_LINE_PREFIX)) {
    readmeLines[2] = statusLine;
    return readmeLines.join("\n");
  }
  const bodyLines = readmeLines.slice(1);
  while (bodyLines[0] === "") bodyLines.shift();
  return [readmeLines[0], "", statusLine, "", ...bodyLines].join("\n");
}

/**
 * Adds or refreshes the Status and ToS risk columns of the root README plugin table.
 *
 * @param rootReadmeText - Root README markdown (string)
 * @param pluginStatuses - Plugin name to status entry (object)
 * @returns The README with both columns filled from the status map (string)
 * @throws Error - When a table row names a plugin without an entry
 */
export function applyStatusColumns(rootReadmeText, pluginStatuses) {
  return rootReadmeText
    .split("\n")
    .map((line) => rewriteTableLine(line, pluginStatuses))
    .join("\n");
}

function rewriteTableLine(line, pluginStatuses) {
  if (line.startsWith("| Plugin | What it does |")) return line.replace("| Plugin |", "| Plugin | Status | ToS risk |");
  if (line.startsWith("|--------|--------------|")) return line.replace("|--------|", "|--------|--------|----------|");
  const rowMatch = TABLE_ROW_PATTERN.exec(line);
  if (!rowMatch) return line;
  const { status, tos_risk: tosRisk } = statusForPlugin(pluginStatuses, rowMatch[1]);
  const statusCells = `${status} | ${tosRisk === "high" ? "**high**" : tosRisk} |`;
  const cells = line.slice(rowMatch[0].length);
  const hasStatusCells = /^ (stable|beta|experimental) \| [^|]+ \|/.test(cells);
  const remainingCells = hasStatusCells ? cells.replace(/^ [^|]+ \| [^|]+ \|/, "") : cells;
  return `${rowMatch[0]} ${statusCells}${remainingCells}`;
}
