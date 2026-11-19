/**
 * tiktok-api plugin definition: the TikTok Open API (profile, videos, Content
 * Posting, OAuth refresh) and the TikTok Business API (comments, direct messages).
 *
 * Operations receive `client = {open, business, oauth}`. The Open API token is
 * resolved without failing, so a run that only has TIKTOK_BUSINESS_ACCESS_TOKEN
 * can still use the Business API operations; each client fails with auth_error
 * naming its env var when its token is missing.
 *
 * Agent policy (README "Agent policy"; TikTok's Content Sharing Guidelines expect per-post creator consent):
 * direct posts (publish_video mode=direct, publish_photos mode=direct), comments and replies need
 * TIKTOK_TOOL_ALLOW_POST=1 as tools; inbox drafts stay free because the creator finishes them in the app. Hiding
 * and liking comments need TIKTOK_TOOL_ALLOW_ENGAGE=1, send_message needs TIKTOK_TOOL_ALLOW_DM=1, and
 * delete_comment and token refresh are node only. Reads are free tools; workflow nodes are never limited.
 */
import { applyAgentPolicy, assertToolOptIn, makeNodeOnly, requireToolOptIn, wrapEach } from "./lib/agent-tool-policy.mjs";
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

export const POST_OPT_IN_ENV = "TIKTOK_TOOL_ALLOW_POST";
export const ENGAGE_OPT_IN_ENV = "TIKTOK_TOOL_ALLOW_ENGAGE";
export const DM_OPT_IN_ENV = "TIKTOK_TOOL_ALLOW_DM";

/**
 * Like requireToolOptIn, but only for mode=direct (the default): inbox and upload drafts are not public until the
 * creator posts them in the TikTok app.
 *
 * @param operation - publish_video or publish_photos (object)
 * @returns Guarded operation (object)
 */
function requireOptInForDirectPosts(operation) {
  return {
    ...operation,
    description: `${operation.description} (mode=direct as an agent tool only when ${POST_OPT_IN_ENV}=1; drafts are always allowed)`,
    run: async (context) => {
      if (context.args.mode === "direct") assertToolOptIn(context, operation.name, POST_OPT_IN_ENV);
      return operation.run(context);
    },
  };
}

const AGENT_POLICY = {
  ...wrapEach(["publish_video", "publish_photos"], requireOptInForDirectPosts),
  ...wrapEach(["create_comment", "reply_to_comment"], requireToolOptIn(POST_OPT_IN_ENV)),
  ...wrapEach(["set_comment_hidden", "set_comment_liked"], requireToolOptIn(ENGAGE_OPT_IN_ENV)),
  send_message: requireToolOptIn(DM_OPT_IN_ENV),
  delete_comment: makeNodeOnly,
};

export const pluginDefinition = {
  name: "tiktok-api",
  version: "0.3.0",
  description: "TikTok profile, videos and Content Posting (Open API), plus comments and DMs (Business API), via the official TikTok APIs",
  tokenEnv: "TIKTOK_ACCESS_TOKEN",
  extraEnv: ["TIKTOK_BUSINESS_ACCESS_TOKEN", "TIKTOK_BUSINESS_ID", "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REFRESH_TOKEN", POST_OPT_IN_ENV, ENGAGE_OPT_IN_ENV, DM_OPT_IN_ENV],
  limits: { timeout_ms: 420000 },
  createClient: createTiktokClients,
  resolveAccessToken: resolveOpenApiToken,
  operations: applyAgentPolicy([
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
  ], AGENT_POLICY),
};
