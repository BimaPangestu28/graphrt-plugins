/**
 * linkedin-api plugin definition: member and organization posts, images,
 * comments and reactions through the official LinkedIn REST API.
 */
import { createLinkedInClient } from "./lib/client.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { engagementOperations } from "./operations/engagement.mjs";
import { postOperations } from "./operations/posts.mjs";

export const pluginDefinition = {
  name: "linkedin-api",
  version: "0.1.0",
  description: "LinkedIn member and organization posts, images, comments and reactions via the official LinkedIn REST API",
  tokenEnv: "LINKEDIN_ACCESS_TOKEN",
  extraEnv: ["LINKEDIN_AUTHOR_URN", "LINKEDIN_VERSION"],
  createClient: createLinkedInClient,
  operations: [
    ...postOperations,
    ...engagementOperations,
    createApiRequestOperation({ apiName: "LinkedIn REST API", examplePath: "/organizations/12345" }),
  ],
};
