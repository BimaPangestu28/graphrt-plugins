/**
 * Comment operations: comment threads on videos/channels, replies, posting,
 * editing, deleting and moderation.
 */
import { paginationProperties, rejectInput, toPage } from "../lib/client.mjs";

const COMMENT_ID_PROPERTY = { type: "string", description: "Comment id" };
const TEXT_PROPERTY = { type: "string", minLength: 1, description: "Comment text" };
const TEXT_FORMAT_PROPERTY = { type: "string", enum: ["plainText", "html"], default: "plainText", description: "Format of textDisplay" };

function buildCommentThreadQuery(args) {
  if (Boolean(args.video_id) === Boolean(args.channel_id)) rejectInput("Pass exactly one of `video_id` or `channel_id`");
  return {
    part: args.part,
    videoId: args.video_id,
    allThreadsRelatedToChannelId: args.channel_id,
    order: args.order,
    searchTerms: args.search_terms,
    moderationStatus: args.moderation_status,
    textFormat: args.text_format,
    maxResults: args.limit,
    pageToken: args.cursor,
  };
}

async function setModerationStatus({ client, args, signal }) {
  if (args.comment_ids.length === 0) rejectInput("`comment_ids` must contain at least one id");
  if (args.ban_author && args.moderation_status !== "rejected") rejectInput("`ban_author` is only allowed with moderation_status `rejected`");
  const query = { id: args.comment_ids, moderationStatus: args.moderation_status, banAuthor: args.ban_author || undefined };
  await client.request({ method: "POST", path: "/comments/setModerationStatus", query, signal });
  return { data: { comment_ids: args.comment_ids, moderation_status: args.moderation_status, ban_author: args.ban_author } };
}

export const commentOperations = [
  {
    name: "list_comment_threads",
    title: "List YouTube comment threads",
    description: "List top-level comments (with some replies) on a video, or on all of a channel's videos. Filter by search terms or moderation status.",
    parameters: {
      type: "object",
      properties: {
        video_id: { type: "string", description: "Video id (or pass channel_id)" },
        channel_id: { type: "string", description: "Channel id: threads on all of its videos" },
        order: { type: "string", enum: ["time", "relevance"] },
        search_terms: { type: "string", description: "Only comments containing these terms" },
        moderation_status: { type: "string", enum: ["published", "heldForReview", "likelySpam"], description: "Needs the channel owner's token for non-published" },
        text_format: TEXT_FORMAT_PROPERTY,
        part: { type: "string", default: "snippet,replies" },
        ...paginationProperties(100),
      },
    },
    run: async ({ client, args, signal }) => toPage(await client.request({ path: "/commentThreads", query: buildCommentThreadQuery(args), signal })),
  },
  {
    name: "list_comment_replies",
    title: "List YouTube comment replies",
    description: "List all replies to a top-level comment.",
    parameters: {
      type: "object",
      properties: { parent_id: { type: "string", description: "Top-level comment id" }, text_format: TEXT_FORMAT_PROPERTY, ...paginationProperties(100) },
      required: ["parent_id"],
    },
    run: async ({ client, args, signal }) => {
      const query = { part: "snippet", parentId: args.parent_id, textFormat: args.text_format, maxResults: args.limit, pageToken: args.cursor };
      return toPage(await client.request({ path: "/comments", query, signal }));
    },
  },
  {
    name: "post_comment",
    title: "Post YouTube comment",
    description: "Post a new top-level comment on a video.",
    parameters: {
      type: "object",
      properties: { video_id: { type: "string" }, text: TEXT_PROPERTY, channel_id: { type: "string", description: "Channel that owns the video (optional)" } },
      required: ["video_id", "text"],
    },
    run: async ({ client, args, signal }) => {
      const snippet = { channelId: args.channel_id, videoId: args.video_id, topLevelComment: { snippet: { textOriginal: args.text } } };
      return { data: await client.request({ method: "POST", path: "/commentThreads", query: { part: "snippet" }, json: { snippet }, signal }) };
    },
  },
  {
    name: "reply_to_comment",
    title: "Reply to YouTube comment",
    description: "Reply to a top-level comment.",
    parameters: { type: "object", properties: { parent_id: { type: "string", description: "Top-level comment id" }, text: TEXT_PROPERTY }, required: ["parent_id", "text"] },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ method: "POST", path: "/comments", query: { part: "snippet" }, json: { snippet: { parentId: args.parent_id, textOriginal: args.text } }, signal }),
    }),
  },
  {
    name: "update_comment",
    title: "Edit YouTube comment",
    description: "Change the text of a comment the authenticated user wrote.",
    parameters: { type: "object", properties: { comment_id: COMMENT_ID_PROPERTY, text: TEXT_PROPERTY }, required: ["comment_id", "text"] },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ method: "PUT", path: "/comments", query: { part: "snippet" }, json: { id: args.comment_id, snippet: { textOriginal: args.text } }, signal }),
    }),
  },
  {
    name: "delete_comment",
    title: "Delete YouTube comment",
    description: "Delete a comment the authenticated user wrote.",
    parameters: { type: "object", properties: { comment_id: COMMENT_ID_PROPERTY }, required: ["comment_id"] },
    run: async ({ client, args, signal }) => {
      await client.request({ method: "DELETE", path: "/comments", query: { id: args.comment_id }, signal });
      return { data: { deleted: true, comment_id: args.comment_id } };
    },
  },
  {
    name: "set_comment_moderation_status",
    title: "Moderate YouTube comments",
    description: "Publish, hold for review or reject up to 50 comments on your channel; optionally ban the author when rejecting.",
    parameters: {
      type: "object",
      properties: {
        comment_ids: { type: "array", items: { type: "string" }, maxItems: 50 },
        moderation_status: { type: "string", enum: ["heldForReview", "published", "rejected"] },
        ban_author: { type: "boolean", default: false, description: "Only with rejected" },
      },
      required: ["comment_ids", "moderation_status"],
    },
    run: setModerationStatus,
  },
];
