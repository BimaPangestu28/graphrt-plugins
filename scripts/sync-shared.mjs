/**
 * Copies shared/lib into every shared-based plugin's lib/shared/ and
 * regenerates each graphrt-plugin.json and OPERATIONS.md from its definition.mjs.
 *
 * Plugins are installed one directory at a time (`graphrt plugin install <dir>`),
 * so each one carries its own copy of the shared code.
 *
 * Usage: node scripts/sync-shared.mjs [--check]
 *   --check  exit 1 instead of writing when anything is out of date
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { findSharedPlugins, SHARED_LIB_DIR } from "./plugins.mjs";
import { buildManifest, offersNodeToken } from "../shared/lib/operations.mjs";

const isCheckMode = process.argv.includes("--check");
const staleFiles = [];

for (const pluginDirectory of findSharedPlugins()) {
  syncSharedLibrary(pluginDirectory);
  await syncManifest(pluginDirectory);
}

if (isCheckMode && staleFiles.length > 0) {
  console.error(`Out of date (run \`npm run sync\`):\n  ${staleFiles.join("\n  ")}`);
  process.exit(1);
}
console.error(isCheckMode ? "All plugins are in sync." : "Synced shared code and manifests.");

function syncSharedLibrary(pluginDirectory) {
  const targetDirectory = join(pluginDirectory, "lib", "shared");
  const sharedFileNames = readdirSync(SHARED_LIB_DIR);
  for (const sharedFileName of sharedFileNames) {
    writeIfChanged(join(targetDirectory, sharedFileName), readFileSync(join(SHARED_LIB_DIR, sharedFileName), "utf8"));
  }
  removeStaleCopies(targetDirectory, new Set(sharedFileNames));
}

function removeStaleCopies(targetDirectory, sharedFileNames) {
  if (!existsSync(targetDirectory)) return;
  for (const copiedFileName of readdirSync(targetDirectory)) {
    if (sharedFileNames.has(copiedFileName)) continue;
    staleFiles.push(join(targetDirectory, copiedFileName));
    if (!isCheckMode) rmSync(join(targetDirectory, copiedFileName));
  }
}

async function syncManifest(pluginDirectory) {
  const { pluginDefinition } = await import(pathToFileURL(join(pluginDirectory, "definition.mjs")).href);
  if (pluginDefinition.name !== basename(pluginDirectory)) {
    throw new Error(`${pluginDirectory}: definition name \`${pluginDefinition.name}\` must match the directory name`);
  }
  writeIfChanged(join(pluginDirectory, "graphrt-plugin.json"), `${JSON.stringify(buildManifest(pluginDefinition), null, 2)}\n`);
  writeIfChanged(join(pluginDirectory, "OPERATIONS.md"), renderOperationsReference(pluginDefinition));
}

function renderOperationsReference(pluginDefinition) {
  const operationRows = pluginDefinition.operations.map((operation) => {
    const requiredNames = new Set(operation.parameters.required ?? []);
    const parameterList = Object.keys(operation.parameters.properties)
      .map((parameterName) => (requiredNames.has(parameterName) ? `**${parameterName}**` : parameterName))
      .join(", ");
    return `| \`${operation.name}\` | ${operation.description.replaceAll("|", "\\|")} | ${parameterList} |`;
  });
  return [
    `# ${pluginDefinition.name} operations`,
    "",
    "Generated from `definition.mjs` by `npm run sync` — do not edit by hand.",
    "",
    `Each operation is a node \`${pluginDefinition.name}.<operation>\` (outputs \`data\`, \`next_cursor\`) and a tool \`<operation>\`.`,
    offersNodeToken(pluginDefinition)
      ? "Nodes also accept an optional `access_token`. **Bold** parameters are required."
      : "**Bold** parameters are required.",
    "",
    "| Operation | Description | Parameters |",
    "|-----------|-------------|------------|",
    ...operationRows,
    "",
  ].join("\n");
}

function writeIfChanged(filePath, expectedContent) {
  const currentContent = existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
  if (currentContent === expectedContent) return;
  staleFiles.push(filePath);
  if (isCheckMode) return;
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, expectedContent);
}
