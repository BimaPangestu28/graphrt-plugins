/**
 * linkedin-api plugin definition: member and organization posts, images,
 * comments and reactions through the official LinkedIn REST API.
 *
 * Agent policy (README "Agent policy"; LinkedIn's API Terms forbid automated posting): creating or editing posts
 * and comments needs LINKEDIN_TOOL_ALLOW_POST=1 as a tool, reactions need LINKEDIN_TOOL_ALLOW_ENGAGE=1, deletes are
 * node only. Reads and upload_image are free tools; workflow nodes are never limited.
 */
import { applyAgentPolicy, makeNodeOnly, requireToolOptIn, wrapEach } from "./lib/agent-tool-policy.mjs";
import { createLinkedInClient } from "./lib/client.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { engagementOperations } from "./operations/engagement.mjs";
import { postOperations } from "./operations/posts.mjs";

export const POST_OPT_IN_ENV = "LINKEDIN_TOOL_ALLOW_POST";
export const ENGAGE_OPT_IN_ENV = "LINKEDIN_TOOL_ALLOW_ENGAGE";

const AGENT_POLICY = {
  ...wrapEach(["create_post", "update_post", "create_comment", "update_comment"], requireToolOptIn(POST_OPT_IN_ENV)),
  ...wrapEach(["add_reaction", "remove_reaction"], requireToolOptIn(ENGAGE_OPT_IN_ENV)),
  ...wrapEach(["delete_post", "delete_comment"], makeNodeOnly),
};

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
    version: "0.2.0",
    description: "LinkedIn member and organization posts, images, comments and reactions via the official LinkedIn REST API",
    tokenEnv: "LINKEDIN_ACCESS_TOKEN",
    extraEnv: ["LINKEDIN_AUTHOR_URN", "LINKEDIN_VERSION", POST_OPT_IN_ENV, ENGAGE_OPT_IN_ENV],
    limits: { timeout_ms: 240000 },
    createClient: (clientOptions) => createLinkedInClient({ ...clientOptions, resolveHostAddresses: dependencies.resolveHostAddresses }),
    operations: applyAgentPolicy(
      [...postOperations, ...engagementOperations, createApiRequestOperation({ apiName: "LinkedIn REST API", examplePath: "/organizations/12345" })],
      AGENT_POLICY,
    ),
  };
}

export const pluginDefinition = createPluginDefinition();
