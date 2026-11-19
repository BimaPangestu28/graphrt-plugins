/**
 * redis plugin definition: binary-safe Redis strings, hashes, lists, sets,
 * sorted sets, streams and pub/sub through ioredis, with key-prefix isolation.
 *
 * The runner's "token" is the Redis URL: REDIS_URL, or a node's
 * `access_token` (from a secret). Every operation's errors pass through a
 * redactor built from that URL before they leave the plugin.
 */
import { PluginError } from "./lib/shared/graphrt-plugin.mjs";
import { createClientFactory } from "./lib/client.mjs";
import { toPluginError } from "./lib/errors.mjs";
import { buildUrlSecrets, createRedactor } from "./lib/redaction.mjs";
import { REDIS_URL_ENV, SETTINGS_ENV } from "./lib/settings.mjs";
import { collectionOperations } from "./operations/collections.mjs";
import { createCommandOperation } from "./operations/command.mjs";
import { stringOperations } from "./operations/strings.mjs";
import { streamOperations } from "./operations/streams.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{loadRedis, timers}` (see createClientFactory) and `{loadFinder}` (see createCommandOperation) (object, optional)
 * @returns Plugin definition plus `closeAllClients()` and `waitForRunningOperations(timeoutMs)` for shutdown (object)
 */
export function createPluginDefinition(dependencies = {}) {
  const { createClient, closeAllClients, waitForRunningOperations } = createClientFactory(dependencies);
  const operations = [...stringOperations, ...collectionOperations, ...streamOperations, createCommandOperation({ loadFinder: dependencies.loadFinder })];
  return {
    name: "redis",
    version: "0.1.0",
    description:
      "Redis: binary-safe strings, hashes, lists, sets, sorted sets, streams, SCAN and publish, with an optional key prefix (agent tools read-only unless REDIS_TOOL_ALLOW_WRITES=1)",
    tokenEnv: REDIS_URL_ENV,
    extraEnv: SETTINGS_ENV,
    // REDIS_COMMAND_TIMEOUT_MS (max 60 s) + 10 s connect stays under the 80 s tool deadline.
    limits: { timeout_ms: 90000, max_concurrency: 8 },
    resolveAccessToken: resolveRedisUrl,
    createClient,
    closeAllClients,
    waitForRunningOperations,
    operations: operations.map(withRedactedErrors),
  };
}

function resolveRedisUrl({ environment, nodeToken }) {
  const redisUrl = (nodeToken || environment?.[REDIS_URL_ENV] || "").trim();
  if (!redisUrl) {
    throw new PluginError("No Redis URL: set REDIS_URL (allow it in permissions.env) or pass `access_token` on the node", { kind: "auth_error" });
  }
  return redisUrl;
}

// Errors can quote the URL or the AUTH exchange, so nothing leaves unredacted.
function withRedactedErrors(operation) {
  return {
    ...operation,
    run: async (context) => {
      try {
        return await operation.run(context);
      } catch (operationError) {
        const redact = context.client?.redact ?? createRedactor(buildUrlSecrets(context.environment?.[REDIS_URL_ENV]));
        throw toPluginError(operationError, redact);
      }
    },
  };
}

export const pluginDefinition = createPluginDefinition();
