/**
 * airtable-api plugin definition: Airtable bases, schemas and records through the official Web API,
 * authenticated with a personal access token.
 */
import { assertToolMayUsePath, BASE_ID_ENV, TOOL_ALLOWED_BASES_ENV } from "./lib/base-access.mjs";
import { createAirtableClient } from "./lib/client.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { metaOperations } from "./operations/meta.mjs";
import { recordOperations } from "./operations/records.mjs";

export const pluginDefinition = {
  name: "airtable-api",
  version: "0.1.0",
  description: "Airtable via the official Web API: bases and schemas, list/find/get records, create, update and upsert records",
  tokenEnv: "AIRTABLE_TOKEN",
  extraEnv: [BASE_ID_ENV, TOOL_ALLOWED_BASES_ENV],
  createClient: createAirtableClient,
  operations: [
    ...metaOperations,
    ...recordOperations,
    createBaseCheckedApiRequestOperation(),
  ],
};

/**
 * Wraps the shared `api_request` so tool calls can only reach the allowed bases.
 *
 * @returns Operation definition (object)
 */
function createBaseCheckedApiRequestOperation() {
  const apiRequestOperation = createApiRequestOperation({ apiName: "Airtable API", examplePath: "/meta/whoami" });
  return {
    ...apiRequestOperation,
    run: (context) => {
      assertToolMayUsePath(context, context.args.path);
      return apiRequestOperation.run(context);
    },
  };
}
