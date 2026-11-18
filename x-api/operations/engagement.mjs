/**
 * Engagement operations: hide replies, like/unlike and repost/undo as the
 * authenticated user.
 */
import { resolveAuthenticatedUserId } from "../lib/client.mjs";
import { numericIdProperty } from "../lib/parameters.mjs";

const POST_ID_PARAMETERS = { type: "object", properties: { post_id: numericIdProperty("Post id") }, required: ["post_id"] };

async function sendAsAuthenticatedUser({ client, signal }, { method, pathSuffix, json }) {
  const userId = await resolveAuthenticatedUserId(client, signal);
  return { data: await client.request({ method, path: `/2/users/${userId}/${pathSuffix}`, json, signal }) };
}

export const engagementOperations = [
  {
    name: "hide_reply",
    title: "Hide/unhide X reply",
    description: "Hide or unhide a reply to one of the authenticated user's posts.",
    parameters: {
      type: "object",
      properties: { post_id: numericIdProperty("Reply post id"), hidden: { type: "boolean", default: true } },
      required: ["post_id"],
    },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ method: "PUT", path: `/2/tweets/${args.post_id}/hidden`, json: { hidden: args.hidden }, signal }),
    }),
  },
  {
    name: "like_post",
    title: "Like X post",
    description: "Like a post as the authenticated user.",
    parameters: POST_ID_PARAMETERS,
    run: (runContext) => sendAsAuthenticatedUser(runContext, { method: "POST", pathSuffix: "likes", json: { tweet_id: runContext.args.post_id } }),
  },
  {
    name: "unlike_post",
    title: "Unlike X post",
    description: "Remove the authenticated user's like from a post.",
    parameters: POST_ID_PARAMETERS,
    run: (runContext) => sendAsAuthenticatedUser(runContext, { method: "DELETE", pathSuffix: `likes/${runContext.args.post_id}` }),
  },
  {
    name: "repost",
    title: "Repost X post",
    description: "Repost (retweet) a post as the authenticated user.",
    parameters: POST_ID_PARAMETERS,
    run: (runContext) => sendAsAuthenticatedUser(runContext, { method: "POST", pathSuffix: "retweets", json: { tweet_id: runContext.args.post_id } }),
  },
  {
    name: "undo_repost",
    title: "Undo X repost",
    description: "Undo the authenticated user's repost of a post.",
    parameters: POST_ID_PARAMETERS,
    run: (runContext) => sendAsAuthenticatedUser(runContext, { method: "DELETE", pathSuffix: `retweets/${runContext.args.post_id}` }),
  },
];
