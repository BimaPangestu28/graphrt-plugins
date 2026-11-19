/**
 * x-api plugin definition: posts, replies, engagement, DMs and media through
 * the official X API v2 with an OAuth 2.0 user access token.
 *
 * Agent policy (README "Agent policy"; X's Automation Rules require consent for automated replies and DMs):
 * publishing (posts, replies, quotes, reposts) needs X_TOOL_ALLOW_POST=1 as a tool, likes and hiding replies need
 * X_TOOL_ALLOW_ENGAGE=1, and DMs need X_TOOL_ALLOW_DM=1 plus every recipient in X_TOOL_RECIPIENT_ALLOWLIST.
 * delete_post and token refresh are node only. Reads are free tools; workflow nodes are never limited.
 */
import { createXClient, resolveXAccessToken } from "./lib/client.mjs";
import { applyAgentPolicy, makeNodeOnly, requireToolOptIn, wrapEach } from "./lib/agent-tool-policy.mjs";
import { withPatternChecks } from "./lib/parameters.mjs";
import { guardRecipients } from "./lib/recipient-policy.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { directMessageOperations } from "./operations/direct-messages.mjs";
import { engagementOperations } from "./operations/engagement.mjs";
import { mediaOperations } from "./operations/media.mjs";
import { postOperations } from "./operations/posts.mjs";
import { tokenOperations } from "./operations/token.mjs";
import { userOperations } from "./operations/users.mjs";

export const POST_OPT_IN_ENV = "X_TOOL_ALLOW_POST";
export const DM_OPT_IN_ENV = "X_TOOL_ALLOW_DM";
export const ENGAGE_OPT_IN_ENV = "X_TOOL_ALLOW_ENGAGE";
export const RECIPIENT_ALLOWLIST_ENV = "X_TOOL_RECIPIENT_ALLOWLIST";
const DM_RECIPIENT_POLICY = { optInEnv: DM_OPT_IN_ENV, allowlistEnv: RECIPIENT_ALLOWLIST_ENV, entryKind: "id" };

// A DM goes to `participant_id`, into `conversation_id` (allowlisted as that exact id) or to every group member.
const directMessageRecipientsOf = (args) => ({
  args,
  recipients: args.participant_ids ?? [args.participant_id ?? args.conversation_id].filter(Boolean),
});

const requireDmOptIn = (operation) =>
  requireToolOptIn(DM_OPT_IN_ENV, `every recipient is in ${RECIPIENT_ALLOWLIST_ENV}`)(guardRecipients(operation, directMessageRecipientsOf, DM_RECIPIENT_POLICY));

const AGENT_POLICY = {
  ...wrapEach(["create_post", "repost", "undo_repost"], requireToolOptIn(POST_OPT_IN_ENV)),
  ...wrapEach(["like_post", "unlike_post", "hide_reply"], requireToolOptIn(ENGAGE_OPT_IN_ENV)),
  ...wrapEach(["send_dm", "create_group_dm"], requireDmOptIn),
  delete_post: makeNodeOnly,
};

const operations = [
  ...userOperations,
  ...postOperations,
  ...engagementOperations,
  ...directMessageOperations,
  ...mediaOperations,
  ...tokenOperations,
  createApiRequestOperation({ apiName: "X API", examplePath: "/2/users/me/followers" }),
];

export const pluginDefinition = {
  name: "x-api",
  version: "0.2.0",
  description: "X (Twitter) posts, replies, likes, reposts, DMs and media via the official X API v2",
  tokenEnv: "X_ACCESS_TOKEN",
  extraEnv: ["X_USER_ID", "X_CLIENT_SECRET", "X_REFRESH_TOKEN", "X_CLIENT_ID", POST_OPT_IN_ENV, DM_OPT_IN_ENV, ENGAGE_OPT_IN_ENV, RECIPIENT_ALLOWLIST_ENV],
  createClient: createXClient,
  resolveAccessToken: resolveXAccessToken,
  // Pattern checks run first, so a malformed id is invalid_input rather than "not in the allowlist".
  operations: applyAgentPolicy(operations, AGENT_POLICY).map(withPatternChecks),
};
