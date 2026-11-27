/**
 * local-files plugin definition: read, list, stat, search and write files
 * inside LOCAL_FILES_ALLOWED_DIRS.
 *
 * There is no token and no network (`localOnly`). Tool calls are read-only
 * unless LOCAL_FILES_TOOL_ALLOW_WRITES=1, and even then they only create new
 * files; overwrites and deletes are for workflow nodes. Every error leaves
 * through a path redactor, so fs messages never reveal paths outside the
 * allowlist.
 */
import { createLocalFilesClient } from "./lib/client.mjs";
import { operationFailed } from "./lib/errors.mjs";
import { ALL_VARIABLES } from "./lib/settings.mjs";
import { browseOperations } from "./operations/browse.mjs";
import { readOperations } from "./operations/read.mjs";
import { writeOperations } from "./operations/write.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{fileSystem, randomSuffix}` overrides (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  return {
    name: "local-files",
    version: "0.1.1",
    description: "Local files in allowed directories: list, stat, read (text or base64, capped), search by name or content, and staged writes that never overwrite unless a node asks; deletes are node only",
    extraEnv: ALL_VARIABLES,
    localOnly: true,
    noCredentials: true,
    limits: { timeout_ms: 120000, max_concurrency: 8 },
    createClient: ({ environment }) => createLocalFilesClient(environment, dependencies),
    operations: [...readOperations, ...browseOperations, ...writeOperations].map(withPluginErrors),
  };
}

// fs errors (EACCES, EIO, ...) become plugin_error with paths outside the allowlist replaced by [path].
function withPluginErrors(operation) {
  return {
    ...operation,
    run: async (context) => {
      try {
        return await operation.run(context);
      } catch (operationError) {
        if (operationError?.kind) throw operationError;
        throw operationFailed(`${operation.name} failed: ${context.client.redactPaths(operationError?.message ?? String(operationError))}`);
      }
    },
  };
}

export const pluginDefinition = createPluginDefinition();
