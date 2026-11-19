/**
 * mongodb plugin definition: query and (opt-in) write MongoDB collections
 * through the official driver, with Extended JSON values at the boundary.
 *
 * The runner's "token" is the connection string: MONGODB_URL, or a node's
 * `access_token` (from a secret). Every operation's errors pass through a
 * redactor built from that string before they leave the plugin.
 */
import { PluginError } from "./lib/shared/graphrt-plugin.mjs";
import { createClientFactory } from "./lib/client.mjs";
import { toPluginError } from "./lib/errors.mjs";
import { buildUrlSecrets, createRedactor } from "./lib/redaction.mjs";
import { MONGODB_URL_ENV, SETTINGS_ENV } from "./lib/settings.mjs";
import { listingOperations } from "./operations/listing.mjs";
import { readingOperations } from "./operations/reading.mjs";
import { writingOperations } from "./operations/writing.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - See createClientFactory: `{loadDriver, timers}` (object, optional)
 * @returns Plugin definition plus `closeAllClients()` and `waitForRunningOperations(timeoutMs)` for shutdown (object)
 */
export function createPluginDefinition(dependencies = {}) {
  const { createClient, closeAllClients, waitForRunningOperations } = createClientFactory(dependencies);
  const operations = [...readingOperations, ...listingOperations, ...writingOperations];
  return {
    name: "mongodb",
    version: "0.1.0",
    description:
      "MongoDB: find, count, distinct and aggregate with Extended JSON, list databases and collections, and insert/update/replace/delete (agent tools read-only unless MONGODB_TOOL_ALLOW_WRITES=1)",
    tokenEnv: MONGODB_URL_ENV,
    extraEnv: SETTINGS_ENV,
    // Tool deadline = timeout_ms - 10 s = 90 s: server selection (10 s, connecting included) + max_time_ms
    // (at most 60 s) + reading the reply (bounded by MONGODB_MAX_RESULT_BYTES) fit inside it.
    limits: { timeout_ms: 100000, max_concurrency: 8 },
    resolveAccessToken: resolveConnectionUrl,
    createClient,
    closeAllClients,
    waitForRunningOperations,
    operations: operations.map(withRedactedErrors),
  };
}

function resolveConnectionUrl({ environment, nodeToken }) {
  const connectionUrl = (nodeToken || environment?.[MONGODB_URL_ENV] || "").trim();
  if (!connectionUrl) {
    throw new PluginError("No connection string: set MONGODB_URL (allow it in permissions.env) or pass `access_token` on the node", { kind: "auth_error" });
  }
  return connectionUrl;
}

// Driver messages can quote the connection string, so nothing leaves unredacted.
function withRedactedErrors(operation) {
  return {
    ...operation,
    run: async (context) => {
      try {
        return await operation.run(context);
      } catch (operationError) {
        const redact = context.client?.redact ?? createRedactor(buildUrlSecrets(context.environment?.[MONGODB_URL_ENV]));
        throw toPluginError(operationError, redact);
      }
    },
  };
}

export const pluginDefinition = createPluginDefinition();
