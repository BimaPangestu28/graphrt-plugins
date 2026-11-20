/**
 * Checks every plugin manifest in the repo for node config properties that graphrt takes from workflow nodes
 * (id, type, title, data, timeout, ... — see shared/lib/reserved-node-keys.mjs). Such a property can never be set
 * from a node. Shared-based plugins are also checked when their definition loads; this script covers hand-written
 * manifests (plugins without a definition.mjs) too.
 *
 * Usage: node scripts/check-reserved-parameters.mjs   (exit 1 and a list of offenders when any are found)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./plugins.mjs";
import { findReservedNodeProperties } from "./lib/reserved-parameters.mjs";

const MANIFEST_FILE_NAME = "graphrt-plugin.json";

function listPluginManifests() {
  return readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(REPO_ROOT, entry.name, MANIFEST_FILE_NAME)))
    .map((entry) => ({ pluginName: entry.name, manifestPath: join(REPO_ROOT, entry.name, MANIFEST_FILE_NAME) }));
}

const offenders = listPluginManifests().flatMap(({ pluginName, manifestPath }) =>
  findReservedNodeProperties(pluginName, JSON.parse(readFileSync(manifestPath, "utf8"))),
);
if (offenders.length > 0) {
  console.error(`Node parameters graphrt reserves (a node can never set them; rename them):\n  ${offenders.join("\n  ")}`);
  process.exit(1);
}
console.error("No plugin uses a graphrt-reserved node parameter.");
