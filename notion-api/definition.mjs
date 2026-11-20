/**
 * notion-api plugin definition: Notion pages, databases (data sources), blocks and comments through the
 * official REST API (Notion-Version 2026-03-11), authenticated with an internal integration secret.
 */
import { createNotionClient } from "./lib/client.mjs";
import { ALLOW_PEOPLE_ENV } from "./lib/people-guard.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { blockOperations } from "./operations/blocks.mjs";
import { databaseOperations } from "./operations/databases.mjs";
import { pageOperations } from "./operations/pages.mjs";

export const pluginDefinition = {
  name: "notion-api",
  version: "0.1.0",
  description: "Notion via the official API: search, pages and properties, database (data source) queries, page content and comments",
  toolUserToken: true,
  tokenEnv: "NOTION_TOKEN",
  extraEnv: [ALLOW_PEOPLE_ENV],
  createClient: createNotionClient,
  operations: [
    ...pageOperations,
    ...databaseOperations,
    ...blockOperations,
    createApiRequestOperation({ apiName: "Notion API", examplePath: "/users/me" }),
  ],
};
