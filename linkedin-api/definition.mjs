/**
 * linkedin-api plugin definition: member and organization posts, images,
 * comments and reactions through the official LinkedIn REST API.
 */
import { createLinkedInClient } from "./lib/client.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { engagementOperations } from "./operations/engagement.mjs";
import { postOperations } from "./operations/posts.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * `limits.timeout_ms` is 240 s so the slowest tool call, upload_image (image download up to 60 s, initializeUpload
 * up to 30 s per attempt with retries, then the PUT up to 60 s), still fits in the tool deadline (timeout_ms - 10 s).
 *
 * @param dependencies - `{resolveHostAddresses}`: `async (hostname) => string[]` used to refuse internal image hosts (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  return {
    name: "linkedin-api",
    version: "0.1.0",
    description: "LinkedIn member and organization posts, images, comments and reactions via the official LinkedIn REST API",
    tokenEnv: "LINKEDIN_ACCESS_TOKEN",
    extraEnv: ["LINKEDIN_AUTHOR_URN", "LINKEDIN_VERSION"],
    limits: { timeout_ms: 240000 },
    createClient: (clientOptions) => createLinkedInClient({ ...clientOptions, resolveHostAddresses: dependencies.resolveHostAddresses }),
    operations: [
      ...postOperations,
      ...engagementOperations,
      createApiRequestOperation({ apiName: "LinkedIn REST API", examplePath: "/organizations/12345" }),
    ],
  };
}

export const pluginDefinition = createPluginDefinition();
