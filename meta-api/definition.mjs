/**
 * meta-api plugin definition: Facebook Page, Instagram professional account,
 * Messenger and Instagram Direct through the Meta Graph API.
 */
import { createMetaClient } from "./lib/client.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { commentOperations } from "./operations/comments.mjs";
import { instagramOperations } from "./operations/instagram.mjs";
import { messagingOperations } from "./operations/messaging.mjs";
import { pageOperations } from "./operations/page.mjs";

export const pluginDefinition = {
  name: "meta-api",
  version: "0.1.0",
  description: "Facebook Page, Instagram, Messenger and Instagram Direct via the official Meta Graph API",
  tokenEnv: "META_ACCESS_TOKEN",
  extraEnv: ["META_PAGE_ID", "META_IG_USER_ID", "META_GRAPH_VERSION"],
  limits: { timeout_ms: 420000 },
  createClient: createMetaClient,
  operations: [
    ...pageOperations,
    ...commentOperations,
    ...instagramOperations,
    ...messagingOperations,
    createApiRequestOperation({ apiName: "Meta Graph API", examplePath: "/me/accounts" }),
  ],
};
