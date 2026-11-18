/**
 * x-api plugin definition: posts, replies, engagement, DMs and media through
 * the official X API v2 with an OAuth 2.0 user access token.
 */
import { createXClient, resolveXAccessToken } from "./lib/client.mjs";
import { withPatternChecks } from "./lib/parameters.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { directMessageOperations } from "./operations/direct-messages.mjs";
import { engagementOperations } from "./operations/engagement.mjs";
import { mediaOperations } from "./operations/media.mjs";
import { postOperations } from "./operations/posts.mjs";
import { tokenOperations } from "./operations/token.mjs";
import { userOperations } from "./operations/users.mjs";

export const pluginDefinition = {
  name: "x-api",
  version: "0.1.0",
  description: "X (Twitter) posts, replies, likes, reposts, DMs and media via the official X API v2",
  tokenEnv: "X_ACCESS_TOKEN",
  extraEnv: ["X_USER_ID", "X_CLIENT_SECRET", "X_REFRESH_TOKEN", "X_CLIENT_ID"],
  createClient: createXClient,
  resolveAccessToken: resolveXAccessToken,
  operations: [
    ...userOperations,
    ...postOperations,
    ...engagementOperations,
    ...directMessageOperations,
    ...mediaOperations,
    ...tokenOperations,
    createApiRequestOperation({ apiName: "X API", examplePath: "/2/users/me/followers" }),
  ].map(withPatternChecks),
};
