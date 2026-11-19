/**
 * sqlite plugin definition: parameterised SQL on local SQLite files with the
 * built-in node:sqlite module (Node.js 22.13+), so there are no npm dependencies.
 *
 * There is no token and no network: `localOnly` makes the manifest ask for
 * neither, and `resolveAccessToken` returns "local". SQLITE_ALLOWED_DIRS is
 * `tokenEnv` only so that it is listed in the manifest's env permissions.
 * Each call runs in its own short-lived worker process (see worker-launcher.mjs).
 */
import { createSqliteClient } from "./lib/client.mjs";
import { createWorkerLauncher } from "./lib/worker-launcher.mjs";
import { ALLOWED_DIRS_VARIABLE, DEFAULT_PATH_VARIABLE, LIMIT_VARIABLES, TOOL_WRITES_VARIABLE } from "./lib/settings.mjs";
import { schemaOperations } from "./operations/schema.mjs";
import { statementOperations } from "./operations/statements.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{launchWorker, fileSystem}` overrides (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  const clientDependencies = { launchWorker: dependencies.launchWorker ?? createWorkerLauncher(), fileSystem: dependencies.fileSystem };
  return {
    name: "sqlite",
    version: "0.1.0",
    description: "SQLite files in allowed directories: parameterised queries on read-only connections, writes and DDL (nodes, or agents with an opt-in), tables, columns and query plans",
    tokenEnv: ALLOWED_DIRS_VARIABLE,
    extraEnv: [DEFAULT_PATH_VARIABLE, ...LIMIT_VARIABLES, TOOL_WRITES_VARIABLE],
    localOnly: true,
    limits: { timeout_ms: 120000, max_concurrency: 4 },
    resolveAccessToken: () => "local",
    createClient: ({ environment }) => createSqliteClient(environment, clientDependencies),
    operations: [...statementOperations, ...schemaOperations],
  };
}

export const pluginDefinition = createPluginDefinition();
