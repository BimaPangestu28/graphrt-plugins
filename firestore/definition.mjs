/**
 * firestore plugin definition: Cloud Firestore (native mode) over the REST API v1 with OAuth (refresh token), a
 * service account key or an access token (lib/google-auth.mjs and friends are byte-identical copies of
 * google-sheets/lib). Values are typed Firestore values, encoded from and decoded to plain JSON.
 *
 * Agent tools read; create/update need FIRESTORE_TOOL_ALLOW_WRITES=1; delete is node only.
 */
import { createFirestoreClient, SETTING_VARIABLES } from "./lib/client.mjs";
import { GOOGLE_AUTH_ENV, resolveGoogleCredentials } from "./lib/google-auth.mjs";
import { documentOperations } from "./operations/documents.mjs";

export const pluginDefinition = {
  name: "firestore",
  version: "0.1.0",
  description: "Google Cloud Firestore: get, list and query documents with plain JSON values, create and update (agents opt-in), delete (node only)",
  tokenEnv: "GOOGLE_ACCESS_TOKEN",
  extraEnv: [...GOOGLE_AUTH_ENV, ...SETTING_VARIABLES],
  limits: { timeout_ms: 120000, max_concurrency: 8 },
  resolveAccessToken: resolveGoogleCredentials,
  createClient: createFirestoreClient,
  operations: documentOperations,
};
