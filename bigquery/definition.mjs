/**
 * bigquery plugin definition: Google BigQuery API v2 with OAuth (refresh token), a service account key or an
 * access token (lib/google-auth.mjs and friends are byte-identical copies of google-sheets/lib).
 *
 * Every query carries a bytes-billed cap (BIGQUERY_MAX_BYTES_BILLED, default 1 GiB). Agent tools may only run
 * SELECT statements (checked with a free dry run) unless BIGQUERY_TOOL_ALLOW_WRITES=1. There is no generic
 * api_request: it would let a call run a query without the cap.
 */
import { createBigQueryClient } from "./lib/client.mjs";
import { GOOGLE_AUTH_ENV, resolveGoogleCredentials } from "./lib/google-auth.mjs";
import { SETTING_VARIABLES } from "./lib/settings.mjs";
import { catalogOperations } from "./operations/catalog.mjs";
import { queryOperations } from "./operations/queries.mjs";

export const pluginDefinition = {
  name: "bigquery",
  version: "0.1.0",
  description: "Google BigQuery: datasets, tables and schemas, parameterised GoogleSQL queries with a bytes-billed cap, dry runs and paged results; agent tools run SELECT only",
  tokenEnv: "GOOGLE_ACCESS_TOKEN",
  extraEnv: [...GOOGLE_AUTH_ENV, ...SETTING_VARIABLES],
  limits: { timeout_ms: 120000, max_concurrency: 8 },
  resolveAccessToken: resolveGoogleCredentials,
  createClient: createBigQueryClient,
  operations: [...catalogOperations, ...queryOperations],
};
