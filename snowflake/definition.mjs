/**
 * snowflake plugin definition: the Snowflake SQL API v2 with key-pair JWT authentication (RS256 via node:crypto,
 * lib/key-pair-jwt.mjs), or a node's OAuth access token. No Snowflake driver.
 *
 * Agent tools only run statements the guard classifies as read-only, with SNOWFLAKE_TOOL_ROLE when set, unless
 * SNOWFLAKE_TOOL_ALLOW_WRITES=1. The least-privilege role is the real boundary (see README).
 */
import { createSnowflakeClient, resolveSnowflakeCredentials } from "./lib/client.mjs";
import { KEY_VARIABLES, SETTING_VARIABLES } from "./lib/settings.mjs";
import { statementOperations } from "./operations/statements.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{readFileImpl, now}` for createSnowflakeClient (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  return {
    name: "snowflake",
    version: "0.1.0",
    description: "Snowflake SQL API with key-pair JWT auth: run statements with bindings, poll async statements, page result partitions, cancel; agent tools read-only with a dedicated role",
    tokenEnv: "SNOWFLAKE_PRIVATE_KEY_PATH",
    extraEnv: [...KEY_VARIABLES, ...SETTING_VARIABLES],
    limits: { timeout_ms: 120000, max_concurrency: 8 },
    resolveAccessToken: resolveSnowflakeCredentials,
    createClient: (runnerInputs) => createSnowflakeClient(runnerInputs, dependencies),
    operations: statementOperations,
  };
}

export const pluginDefinition = createPluginDefinition();
