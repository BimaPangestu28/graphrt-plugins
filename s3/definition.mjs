/**
 * s3 plugin definition: Amazon S3 and S3-compatible stores (Cloudflare R2, MinIO, ...) over the REST API with
 * AWS Signature Version 4 implemented in lib/aws-sigv4.mjs (no AWS SDK).
 *
 * The runner's "token" is the credential set: a node's `access_token` (`ACCESS_KEY_ID:SECRET[:SESSION_TOKEN]`),
 * else S3_* or AWS_* variables. Agent tools are read-only unless S3_TOOL_ALLOW_WRITES=1; delete and presigned
 * URLs are node only.
 */
import { createS3Client } from "./lib/client.mjs";
import { PluginError } from "./lib/shared/graphrt-plugin.mjs";
import { CREDENTIAL_VARIABLES, resolveCredentials, SETTING_VARIABLES } from "./lib/settings.mjs";
import { listingOperations } from "./operations/listing.mjs";
import { objectOperations } from "./operations/objects.mjs";
import { assertToolBucketsAllowed } from "./operations/properties.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{now, retryBaseDelayMs}` for createS3Client (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  return {
    name: "s3",
    version: "0.1.0",
    description: "Amazon S3 and S3-compatible storage (R2, MinIO): list buckets and objects, metadata, download to an allowed directory, upload, copy, delete and presigned URLs (SigV4)",
    tokenEnv: "AWS_SECRET_ACCESS_KEY",
    extraEnv: [...CREDENTIAL_VARIABLES, ...SETTING_VARIABLES],
    limits: { timeout_ms: 360000, max_concurrency: 8 },
    resolveAccessToken: resolveCredentials,
    createClient: (runnerInputs) => createS3Client(runnerInputs, dependencies),
    operations: [...listingOperations, ...objectOperations].map(withRedactedErrors),
  };
}

// Checks the agent bucket allowlist first. Belt and braces on errors: the transport already redacts, but no error
// may leave with the secret key or session token.
function withRedactedErrors(operation) {
  return {
    ...operation,
    run: async (context) => {
      try {
        assertToolBucketsAllowed(context);
        return await operation.run(context);
      } catch (operationError) {
        if (!(operationError instanceof PluginError)) throw operationError;
        throw new PluginError(context.client.transport.redact(operationError.message), { kind: operationError.kind, retryable: operationError.retryable, retryAfterMs: operationError.retryAfterMs });
      }
    },
  };
}

export const pluginDefinition = createPluginDefinition();
