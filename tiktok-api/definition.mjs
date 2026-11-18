/**
 * tiktok-api plugin definition: the TikTok Open API (profile, videos, Content
 * Posting, OAuth refresh) and the TikTok Business API (comments, direct messages).
 *
 * Operations receive `client = {open, business, oauth}`. The Open API token is
 * resolved without failing, so a run that only has TIKTOK_BUSINESS_ACCESS_TOKEN
 * can still use the Business API operations; each client fails with auth_error
 * naming its env var when its token is missing.
 */
import { createTiktokClients, resolveOpenApiToken } from "./lib/client.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { accountOperations } from "./operations/account.mjs";
import { businessCommentOperations, businessMessageOperations } from "./operations/business.mjs";
import { publishingOperations } from "./operations/publishing.mjs";

const API_SELECTOR_PROPERTY = {
  api: {
    type: "string",
    enum: ["open", "business"],
    default: "open",
    description: "open = open.tiktokapis.com (TIKTOK_ACCESS_TOKEN); business = business-api.tiktok.com/open_api/v1.3 (TIKTOK_BUSINESS_ACCESS_TOKEN)",
  },
};

export const pluginDefinition = {
  name: "tiktok-api",
  version: "0.1.0",
  description: "TikTok profile, videos and Content Posting (Open API), plus comments and DMs (Business API), via the official TikTok APIs",
  tokenEnv: "TIKTOK_ACCESS_TOKEN",
  extraEnv: ["TIKTOK_BUSINESS_ACCESS_TOKEN", "TIKTOK_BUSINESS_ID", "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REFRESH_TOKEN"],
  limits: { timeout_ms: 420000 },
  createClient: createTiktokClients,
  resolveAccessToken: resolveOpenApiToken,
  operations: [
    ...accountOperations,
    ...publishingOperations,
    ...businessCommentOperations,
    ...businessMessageOperations,
    createApiRequestOperation({
      apiName: "TikTok API",
      examplePath: "/v2/user/info/",
      extraProperties: API_SELECTOR_PROPERTY,
      selectClient: (client, args) => client[args.api],
    }),
  ],
};
