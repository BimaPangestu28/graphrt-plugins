/**
 * Code that only some plugins need, kept once under `shared/optional/` and
 * copied into the plugins named in `shared/optional/plugins.json`:
 *
 *   { "lib/pdf-protection.mjs": ["document-templates", "pdf-tools"] }
 *
 * A key is a file under `shared/optional/` and also where the copy goes
 * inside each plugin. `shared/lib` is for every plugin; a file that needs an
 * npm package only some plugins install belongs here instead.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const OPTIONAL_PLUGINS_FILE_NAME = "plugins.json";
const FILE_PATH_PATTERN = /^(lib|test)\/[a-z0-9][a-z0-9.-]*\.mjs$/;
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function listFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? listFiles(join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]));
}

/**
 * Reads which optional shared file goes into which plugins.
 *
 * @param optionalDirectory - `shared/optional` (string)
 * @param repositoryRoot - Directory that holds the plugin directories (string)
 * @returns `[{relativePath, content, pluginDirectories}]`, sorted by path; empty when the directory does not exist (object[])
 * @throws Error - When plugins.json names a missing file or plugin, a path outside `lib/` and `test/`, or leaves a file out
 */
export function readOptionalSharedFiles(optionalDirectory, repositoryRoot) {
  const listPath = join(optionalDirectory, OPTIONAL_PLUGINS_FILE_NAME);
  if (!existsSync(listPath)) return [];
  const pluginsByFile = JSON.parse(readFileSync(listPath, "utf8"));
  const unlistedFiles = listFiles(optionalDirectory).filter((relativePath) => relativePath !== OPTIONAL_PLUGINS_FILE_NAME && !Object.hasOwn(pluginsByFile, relativePath));
  if (unlistedFiles.length > 0) throw new Error(`shared/optional/${OPTIONAL_PLUGINS_FILE_NAME} does not say which plugins get ${unlistedFiles.join(", ")}`);
  return Object.keys(pluginsByFile).sort().map((relativePath) => {
    const pluginNames = pluginsByFile[relativePath];
    if (!FILE_PATH_PATTERN.test(relativePath)) throw new Error(`shared/optional: ${JSON.stringify(relativePath)} must be a .mjs file directly in lib/ or test/`);
    if (!existsSync(join(optionalDirectory, relativePath))) throw new Error(`shared/optional/${relativePath} is listed in ${OPTIONAL_PLUGINS_FILE_NAME} but does not exist`);
    if (!Array.isArray(pluginNames) || pluginNames.length === 0) throw new Error(`shared/optional: ${relativePath} must name at least one plugin`);
    for (const pluginName of pluginNames) {
      if (typeof pluginName !== "string" || !PLUGIN_NAME_PATTERN.test(pluginName) || !existsSync(join(repositoryRoot, pluginName, "definition.mjs"))) throw new Error(`shared/optional: ${relativePath} names ${JSON.stringify(pluginName)}, which is not a plugin with a definition.mjs`);
    }
    return { relativePath, content: readFileSync(join(optionalDirectory, relativePath), "utf8"), pluginDirectories: pluginNames.map((pluginName) => join(repositoryRoot, pluginName)) };
  });
}
