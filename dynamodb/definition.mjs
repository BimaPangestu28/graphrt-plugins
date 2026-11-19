/**
 * dynamodb plugin definition: Amazon DynamoDB over its JSON API with AWS Signature Version 4
 * (lib/aws-sigv4.mjs, a byte-identical copy of the s3 plugin's signer; no AWS SDK).
 *
 * The runner's "token" is the credential set: a node's `access_token` (`ACCESS_KEY_ID:SECRET[:SESSION_TOKEN]`),
 * else AWS_* variables. Agent tools read; put/update need DYNAMODB_TOOL_ALLOW_WRITES=1; delete is node only.
 */
import { createDynamoClient } from "./lib/client.mjs";
import { CREDENTIAL_VARIABLES, resolveCredentials, SETTING_VARIABLES } from "./lib/settings.mjs";
import { itemOperations } from "./operations/items.mjs";
import { assertToolTableAllowed } from "./operations/request-parts.mjs";
import { tableOperations } from "./operations/tables.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{now, retryBaseDelayMs}` for createDynamoClient (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  return {
    name: "dynamodb",
    version: "0.1.0",
    description: "Amazon DynamoDB (SigV4): list and describe tables, get, query, scan and batch-get items with plain JSON values, put/update (agents opt-in) and delete (node only)",
    tokenEnv: "AWS_SECRET_ACCESS_KEY",
    extraEnv: [...CREDENTIAL_VARIABLES, ...SETTING_VARIABLES],
    limits: { timeout_ms: 120000, max_concurrency: 8 },
    resolveAccessToken: resolveCredentials,
    createClient: (runnerInputs) => createDynamoClient(runnerInputs, dependencies),
    operations: [...tableOperations, ...itemOperations].map(withTableAllowlist),
  };
}

export const pluginDefinition = createPluginDefinition();

// Agent tool calls are checked against DYNAMODB_ALLOWED_TABLES before any request is built.
function withTableAllowlist(operation) {
  return {
    ...operation,
    run: (context) => {
      assertToolTableAllowed(context);
      return operation.run(context);
    },
  };
}
