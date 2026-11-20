/**
 * threads-api plugin definition: profile, posts, publishing and reply
 * moderation through the official Threads API.
 *
 * Agent policy (README "Agent policy"): publishing (posts, replies, quotes) and reposts need
 * THREADS_TOOL_ALLOW_POST=1 as tools, hiding and approving replies need THREADS_TOOL_ALLOW_ENGAGE=1, and
 * delete_thread and token refresh are node only. Reads are free tools; workflow nodes are never limited.
 */
import { applyAgentPolicy, makeNodeOnly, requireToolOptIn, wrapEach } from "./lib/agent-tool-policy.mjs";
import { createThreadsClient } from "./lib/client.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { postOperations } from "./operations/posts.mjs";
import { profileOperations } from "./operations/profile.mjs";
import { publishOperations } from "./operations/publish.mjs";
import { replyOperations } from "./operations/replies.mjs";

export const POST_OPT_IN_ENV = "THREADS_TOOL_ALLOW_POST";
export const ENGAGE_OPT_IN_ENV = "THREADS_TOOL_ALLOW_ENGAGE";

const AGENT_POLICY = {
  ...wrapEach(["publish_thread", "repost_thread"], requireToolOptIn(POST_OPT_IN_ENV)),
  ...wrapEach(["hide_reply", "approve_pending_reply"], requireToolOptIn(ENGAGE_OPT_IN_ENV)),
  delete_thread: makeNodeOnly,
};

export const pluginDefinition = {
  name: "threads-api",
  version: "0.3.0",
  description: "Threads profiles, posts, publishing, replies, mentions and search via the official Threads API",
  toolUserToken: true,
  tokenEnv: "THREADS_ACCESS_TOKEN",
  extraEnv: [POST_OPT_IN_ENV, ENGAGE_OPT_IN_ENV],
  // Publishing can wait up to 5 minutes per container, plus carousel children.
  limits: { timeout_ms: 420000 },
  createClient: createThreadsClient,
  operations: applyAgentPolicy(
    [
      ...profileOperations,
      ...postOperations,
      ...publishOperations,
      ...replyOperations,
      createApiRequestOperation({ apiName: "Threads API", examplePath: "/me/threads_insights" }),
    ],
    AGENT_POLICY,
  ),
};
