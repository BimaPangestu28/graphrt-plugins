/**
 * The oldest graphrt Desktop version that can use a plugin: the catalog's `min_app_version`.
 *
 * Why it is in the catalog and not in the manifest: every released Desktop reads `graphrt-plugin.json` strictly
 * (an unknown key fails the install with "unknown field"), so a new manifest key would break the very apps it is
 * meant to warn. Catalog entries are read leniently by every release, so an extra field there is ignored by apps
 * that do not know it. Desktop 0.2.1 and newer read it: a plugin that needs a newer app shows "Needs Graphrt
 * Desktop X or newer" and cannot be installed until the app is updated.
 *
 * The version is not typed by hand per plugin. It is the highest of:
 * 1. what the released manifest uses, from MANIFEST_FEATURES (e.g. `triggers` -> 0.2.0);
 * 2. a floor declared in `plugin-requirements.json`, for a need the manifest cannot show (the app must draw what
 *    the plugin returns, as for ui-render).
 * A plugin with neither has no `min_app_version`: it runs on every release.
 *
 * Adding a manifest feature: a manifest that uses a key, runtime, node field or output type outside BASELINE and
 * outside MANIFEST_FEATURES fails `npm test` (check-app-requirements.mjs), so the feature cannot ship without
 * the Desktop version that first reads it being written down here.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../plugins.mjs";

export const APP_REQUIREMENTS_FILE_NAME = "plugin-requirements.json";
export const MIN_APP_VERSION_FIELD = "min_app_version";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REQUIREMENT_FIELDS = new Set([MIN_APP_VERSION_FIELD, "reason"]);

/**
 * What the manifest reader of the oldest Desktop still in use (0.1.8, graphrt e1e9aa8) accepts. Anything else in
 * a manifest must be listed in MANIFEST_FEATURES.
 */
export const BASELINE = Object.freeze({
  appVersion: "0.1.8",
  manifestKeys: new Set([
    "name", "version", "description", "author", "license", "homepage", "protocol_version", "runtime",
    "command", "args", "env", "inherit_env", "cwd", "url", "headers", "bearer_token_env", "module",
    "permissions", "limits", "checksums", "nodes", "tools", "allow_unprefixed_kinds",
  ]),
  runtimes: new Set(["process"]),
  permissionKeys: new Set(["network", "env", "secrets"]),
  limitKeys: new Set(["timeout_ms", "max_concurrency", "max_message_bytes"]),
  nodeKeys: new Set(["kind", "title", "description", "category", "config_schema", "outputs", "dynamic_outputs", "handles", "container", "icon", "source"]),
  outputKeys: new Set(["name", "type", "description", "streaming"]),
  outputTypes: new Set([
    "any", "none", "string", "text-input", "paragraph", "select", "secret", "number", "integer", "float", "boolean", "checkbox",
    "object", "json", "file", "array[any]", "array", "array[string]", "array[number]", "array[boolean]", "array[object]",
    "array[file]", "file-list",
  ]),
});

/**
 * Manifest features newer than BASELINE, each with the first Desktop version that reads it. `uses` is true when
 * the key is present at all (even empty): the strict reader of an older app refuses the key, not its content.
 */
export const MANIFEST_FEATURES = Object.freeze([
  {
    id: "triggers",
    minAppVersion: "0.2.0",
    reason: "starts agents on events (manifest `triggers`)",
    manifestKeys: ["triggers"],
    uses: (manifest) => Object.hasOwn(manifest, "triggers"),
  },
  {
    id: "mcp-preset",
    minAppVersion: "0.2.0",
    reason: "adds an online service (manifest `runtime: mcp`)",
    manifestKeys: ["mcp"],
    runtimes: ["mcp"],
    uses: (manifest) => manifest.runtime === "mcp" || Object.hasOwn(manifest, "mcp"),
  },
  {
    id: "templates",
    minAppVersion: "0.2.0",
    reason: "offers starter agents (manifest `templates`)",
    manifestKeys: ["templates"],
    uses: (manifest) => Object.hasOwn(manifest, "templates"),
  },
  {
    id: "services",
    minAppVersion: "0.3.0",
    reason: "runs on a collaboration server (manifest `services`)",
    manifestKeys: ["services"],
    uses: (manifest) => Object.hasOwn(manifest, "services"),
  },
]);

/**
 * Parses `major.minor.patch`.
 *
 * @param version - Version text (string)
 * @returns `[major, minor, patch]`, or null when it is not three plain numbers (number[]|null)
 */
export function parseAppVersion(version) {
  const match = typeof version === "string" ? VERSION_PATTERN.exec(version) : null;
  return match ? match.slice(1).map(Number) : null;
}

/**
 * Orders two app versions.
 *
 * @param left - `major.minor.patch` (string)
 * @param right - `major.minor.patch` (string)
 * @returns Negative when left is older, 0 when equal, positive when newer (number)
 * @throws Error - When either is not `major.minor.patch`
 */
export function compareAppVersions(left, right) {
  const [leftParts, rightParts] = [left, right].map((version) => {
    const parts = parseAppVersion(version);
    if (!parts) throw new Error(`\`${version}\` is not an app version (major.minor.patch)`);
    return parts;
  });
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

/**
 * Reads `plugin-requirements.json`: plugin name to `{min_app_version, reason}`.
 *
 * @param requirementsFilePath - File to read (string, default: the repo root file)
 * @returns The declared floors; empty when the file does not exist (object)
 * @throws Error - When the file is not valid JSON
 */
export function readDeclaredRequirements(requirementsFilePath = join(REPO_ROOT, APP_REQUIREMENTS_FILE_NAME)) {
  if (!existsSync(requirementsFilePath)) return {};
  return JSON.parse(readFileSync(requirementsFilePath, "utf8"));
}

/**
 * Lists every problem in the declared floors.
 *
 * @param declaredRequirements - Plugin name to `{min_app_version, reason}` (object)
 * @param pluginNames - Plugin directories in the repo (string[])
 * @returns Human-readable problems; empty when the map is valid (string[])
 */
export function findDeclaredRequirementProblems(declaredRequirements, pluginNames) {
  const knownPlugins = new Set(pluginNames);
  const problems = [];
  for (const [pluginName, requirement] of Object.entries(declaredRequirements)) {
    if (!knownPlugins.has(pluginName)) problems.push(`${pluginName}: no such plugin directory`);
    if (typeof requirement !== "object" || requirement === null || Array.isArray(requirement)) {
      problems.push(`${pluginName}: the entry must be an object`);
      continue;
    }
    for (const field of Object.keys(requirement)) {
      if (!REQUIREMENT_FIELDS.has(field)) problems.push(`${pluginName}: unknown field \`${field}\``);
    }
    if (!parseAppVersion(requirement[MIN_APP_VERSION_FIELD])) problems.push(`${pluginName}: \`${MIN_APP_VERSION_FIELD}\` must be major.minor.patch, e.g. "0.2.0"`);
    if (typeof requirement.reason !== "string" || !requirement.reason.trim()) problems.push(`${pluginName}: \`reason\` must say what the app has to be able to do`);
  }
  return problems;
}

/**
 * The oldest Desktop version that can use a plugin, and why.
 *
 * @param manifest - The plugin manifest (object)
 * @param declaredRequirements - Declared floors by plugin name (object, default: the repo's plugin-requirements.json)
 * @returns `{minAppVersion, reasons}`: the highest version any reason asks for, or null when the plugin runs on
 *   every release; `reasons` is `{minAppVersion, reason}` per manifest feature and declared floor (object)
 */
export function describeAppRequirement(manifest, declaredRequirements = readDeclaredRequirements()) {
  const reasons = MANIFEST_FEATURES.filter((feature) => feature.uses(manifest)).map(({ minAppVersion, reason }) => ({ minAppVersion, reason }));
  const declared = Object.hasOwn(declaredRequirements, manifest.name) ? declaredRequirements[manifest.name] : null;
  if (declared && parseAppVersion(declared[MIN_APP_VERSION_FIELD])) {
    reasons.push({ minAppVersion: declared[MIN_APP_VERSION_FIELD], reason: declared.reason ?? "" });
  }
  const minAppVersion = reasons.reduce((highest, { minAppVersion: version }) => (highest === null || compareAppVersions(version, highest) > 0 ? version : highest), null);
  return { minAppVersion, reasons };
}

/**
 * The catalog fields that state a plugin's app requirement.
 *
 * @param manifest - The released manifest (object)
 * @param declaredRequirements - Declared floors by plugin name (object, default: the repo's plugin-requirements.json)
 * @returns `{min_app_version}`, or `{}` for a plugin that runs on every release (object)
 */
export function appRequirementFields(manifest, declaredRequirements = readDeclaredRequirements()) {
  const { minAppVersion } = describeAppRequirement(manifest, declaredRequirements);
  return minAppVersion === null ? {} : { [MIN_APP_VERSION_FIELD]: minAppVersion };
}

/**
 * Lists what a manifest uses that neither BASELINE nor MANIFEST_FEATURES knows: a feature added to graphrt
 * without stating which Desktop version first reads it.
 *
 * @param manifest - The plugin manifest (object)
 * @returns Human-readable problems; empty when everything the manifest uses is accounted for (string[])
 */
export function findUnaccountedManifestFeatures(manifest) {
  const featureKeys = new Set(MANIFEST_FEATURES.flatMap((feature) => feature.manifestKeys ?? []));
  const featureRuntimes = new Set(MANIFEST_FEATURES.flatMap((feature) => feature.runtimes ?? []));
  const found = [];
  const unknownKeys = (object, known, where) => {
    if (typeof object !== "object" || object === null || Array.isArray(object)) return;
    for (const key of Object.keys(object)) {
      if (!known.has(key)) found.push(`${where} \`${key}\``);
    }
  };
  for (const key of Object.keys(manifest)) {
    if (!BASELINE.manifestKeys.has(key) && !featureKeys.has(key)) found.push(`manifest key \`${key}\``);
  }
  if (!BASELINE.runtimes.has(manifest.runtime) && !featureRuntimes.has(manifest.runtime)) found.push(`runtime \`${manifest.runtime}\``);
  unknownKeys(manifest.permissions, BASELINE.permissionKeys, "permissions key");
  unknownKeys(manifest.limits, BASELINE.limitKeys, "limits key");
  for (const node of Array.isArray(manifest.nodes) ? manifest.nodes : []) {
    unknownKeys(node, BASELINE.nodeKeys, `node ${node?.kind}: key`);
    for (const output of Array.isArray(node?.outputs) ? node.outputs : []) {
      unknownKeys(output, BASELINE.outputKeys, `node ${node.kind}: output key`);
      if (!BASELINE.outputTypes.has(output?.type)) found.push(`node ${node.kind}: output type \`${output?.type}\``);
    }
  }
  const unique = [...new Set(found)];
  return unique.map((what) => `${manifest.name}: ${what} is not read by Desktop ${BASELINE.appVersion} and has no entry in MANIFEST_FEATURES (scripts/lib/app-requirements.mjs); add it with the first Desktop version that reads it`);
}
