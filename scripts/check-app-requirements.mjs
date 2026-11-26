/**
 * Checks that the oldest graphrt Desktop version each plugin needs can be worked out (see
 * scripts/lib/app-requirements.mjs): `plugin-requirements.json` is valid, and no manifest in the repo uses a
 * manifest feature that has no known first Desktop version. Without this a plugin using a new feature would be
 * listed for apps that cannot install it, and they would show a technical error instead of "update the app".
 *
 * Usage: node scripts/check-app-requirements.mjs [--list]
 *   --list  also print every plugin that needs a minimum Desktop version, with the reasons
 *   (exit 1 and a list of problems when any are found)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./plugins.mjs";
import { MANIFEST_FILE_NAME, listPluginNames } from "./lib/plugin-package.mjs";
import {
  APP_REQUIREMENTS_FILE_NAME, describeAppRequirement, findDeclaredRequirementProblems, findUnaccountedManifestFeatures, readDeclaredRequirements,
} from "./lib/app-requirements.mjs";

const pluginNames = listPluginNames();
const declaredRequirements = readDeclaredRequirements();
const manifests = pluginNames.map((pluginName) => JSON.parse(readFileSync(join(REPO_ROOT, pluginName, MANIFEST_FILE_NAME), "utf8")));
const problems = [
  ...findDeclaredRequirementProblems(declaredRequirements, pluginNames).map((problem) => `${APP_REQUIREMENTS_FILE_NAME}: ${problem}`),
  ...manifests.flatMap((manifest) => findUnaccountedManifestFeatures(manifest)),
];
if (problems.length > 0) {
  console.error(`The Desktop version some plugins need cannot be worked out:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
const requirements = manifests
  .map((manifest) => ({ name: manifest.name, ...describeAppRequirement(manifest, declaredRequirements) }))
  .filter((requirement) => requirement.minAppVersion !== null);
if (process.argv.includes("--list")) {
  for (const { name, minAppVersion, reasons } of requirements) {
    console.log(`${name}: Desktop ${minAppVersion} or newer (${reasons.map((entry) => `${entry.reason}: ${entry.minAppVersion}`).join("; ")})`);
  }
}
console.error(`${requirements.length} of ${manifests.length} plugins need a minimum Desktop version; every manifest feature in use has one.`);
