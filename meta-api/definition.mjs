/**
 * meta-api plugin definition: Facebook Page, Instagram professional account,
 * Messenger and Instagram Direct through the Meta Graph API.
 *
 * Agent policy (README "Agent policy"; Meta's Developer Policies require consent before publishing for someone):
 * Page posts, Instagram publishing and comment replies need META_TOOL_ALLOW_POST=1 as tools, hiding and liking
 * comments need META_TOOL_ALLOW_ENGAGE=1, and send_message needs META_TOOL_ALLOW_DM=1 plus the recipient (PSID or
 * IGSID) in META_TOOL_RECIPIENT_ALLOWLIST. Deletes are node only. Reads are free tools; workflow nodes are never
 * limited.
 */
import { applyAgentPolicy, makeNodeOnly, requireToolOptIn, wrapEach } from "./lib/agent-tool-policy.mjs";
import { createMetaClient } from "./lib/client.mjs";
import { guardRecipients } from "./lib/recipient-policy.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { commentOperations } from "./operations/comments.mjs";
import { instagramOperations } from "./operations/instagram.mjs";
import { messagingOperations } from "./operations/messaging.mjs";
import { pageOperations } from "./operations/page.mjs";

export const POST_OPT_IN_ENV = "META_TOOL_ALLOW_POST";
export const ENGAGE_OPT_IN_ENV = "META_TOOL_ALLOW_ENGAGE";
export const DM_OPT_IN_ENV = "META_TOOL_ALLOW_DM";
export const RECIPIENT_ALLOWLIST_ENV = "META_TOOL_RECIPIENT_ALLOWLIST";
const DM_RECIPIENT_POLICY = { optInEnv: DM_OPT_IN_ENV, allowlistEnv: RECIPIENT_ALLOWLIST_ENV, entryKind: "id" };

const requireDmOptIn = (operation) =>
  requireToolOptIn(DM_OPT_IN_ENV, `the recipient is in ${RECIPIENT_ALLOWLIST_ENV}`)(
    guardRecipients(operation, (args) => ({ args, recipients: [args.recipient_id] }), DM_RECIPIENT_POLICY),
  );

const PUBLISHING_OPERATIONS = ["create_page_post", "create_page_photo_post", "update_page_post", "reply_to_comment", "publish_instagram_media", "reply_to_instagram_comment"];
const ENGAGEMENT_OPERATIONS = ["set_comment_hidden", "like_comment", "unlike_comment", "set_instagram_comment_hidden"];

const AGENT_POLICY = {
  ...wrapEach(PUBLISHING_OPERATIONS, requireToolOptIn(POST_OPT_IN_ENV)),
  ...wrapEach(ENGAGEMENT_OPERATIONS, requireToolOptIn(ENGAGE_OPT_IN_ENV)),
  send_message: requireDmOptIn,
  ...wrapEach(["delete_page_post", "delete_comment", "delete_instagram_comment"], makeNodeOnly),
};

export const pluginDefinition = {
  name: "meta-api",
  version: "0.2.0",
  description: "Facebook Page, Instagram, Messenger and Instagram Direct via the official Meta Graph API",
  tokenEnv: "META_ACCESS_TOKEN",
  extraEnv: ["META_PAGE_ID", "META_IG_USER_ID", "META_GRAPH_VERSION", POST_OPT_IN_ENV, ENGAGE_OPT_IN_ENV, DM_OPT_IN_ENV, RECIPIENT_ALLOWLIST_ENV],
  limits: { timeout_ms: 420000 },
  createClient: createMetaClient,
  operations: applyAgentPolicy(
    [
      ...pageOperations,
      ...commentOperations,
      ...instagramOperations,
      ...messagingOperations,
      createApiRequestOperation({ apiName: "Meta Graph API", examplePath: "/me/accounts" }),
    ],
    AGENT_POLICY,
  ),
};
