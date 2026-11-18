/**
 * Business API operations (TikTok account of a business): comment moderation
 * and direct messages. Field names follow the research notes, which come from
 * a third-party client, so they still need live verification.
 */
import { resolveBusinessId, toCursorPage } from "../lib/client.mjs";

const BUSINESS_ID_PROPERTY = { type: "string", description: "TikTok business account id / open_id (default: TIKTOK_BUSINESS_ID)" };
const VIDEO_ID_PROPERTY = { type: "string", minLength: 1, description: "TikTok video id" };
const COMMENT_ID_PROPERTY = { type: "string", minLength: 1, description: "Comment id" };
const CURSOR_PROPERTY = { type: "string", description: "next_cursor from a previous call" };
const LIMIT_PROPERTY = { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Page size" };
const CONVERSATION_TYPE_PROPERTY = { type: "string", enum: ["SINGLE", "STRANGER"], default: "SINGLE", description: "Conversation folder" };

const businessIdOf = (args, environment) => resolveBusinessId(args.business_id, environment);

/**
 * Builds a Business API POST operation that sends `{business_id, ...fields}`.
 *
 * @param definition - `{name, title, description, properties, required, path, buildBody}` (object)
 * @returns Operation definition (object)
 */
function defineBusinessWrite({ name, title, description, properties, required, path, buildBody }) {
  return {
    name,
    title,
    description,
    parameters: { type: "object", properties: { business_id: BUSINESS_ID_PROPERTY, ...properties }, required },
    run: async ({ client, args, environment, signal }) => {
      const requestBody = { business_id: businessIdOf(args, environment), ...buildBody(args) };
      const responseBody = await client.business.request({ method: "POST", path, json: requestBody, signal });
      return { data: responseBody?.data ?? null };
    },
  };
}

/**
 * Builds a Business API GET list operation with cursor pagination.
 *
 * @param definition - `{name, title, description, properties, required, path, listKey, buildQuery}` (object)
 * @returns Operation definition (object)
 */
function defineBusinessList({ name, title, description, properties, required, path, listKey, buildQuery }) {
  return {
    name,
    title,
    description,
    parameters: { type: "object", properties: { business_id: BUSINESS_ID_PROPERTY, ...properties, cursor: CURSOR_PROPERTY }, required },
    run: async ({ client, args, environment, signal }) => {
      const query = { business_id: businessIdOf(args, environment), ...buildQuery(args), cursor: args.cursor };
      const responseBody = await client.business.request({ path, query, signal });
      return toCursorPage(responseBody?.data, listKey);
    },
  };
}

export const businessCommentOperations = [
  defineBusinessList({
    name: "list_comments",
    title: "List TikTok comments",
    description: "List comments on one of the business account's videos (Business API).",
    properties: {
      video_id: VIDEO_ID_PROPERTY,
      status: { type: "string", enum: ["PUBLIC", "HIDDEN", "ALL"], default: "PUBLIC" },
      include_replies: { type: "boolean" },
      sort_field: { type: "string", description: "e.g. create_time or likes" },
      sort_type: { type: "string", enum: ["ASC", "DESC"] },
      limit: LIMIT_PROPERTY,
    },
    required: ["video_id"],
    path: "/business/comment/list/",
    listKey: "comments",
    buildQuery: (args) => ({
      video_id: args.video_id,
      status: args.status,
      include_replies: args.include_replies,
      sort_field: args.sort_field,
      sort_type: args.sort_type,
      max_count: args.limit,
    }),
  }),
  defineBusinessList({
    name: "list_comment_replies",
    title: "List TikTok comment replies",
    description: "List replies to a comment on the business account's video (Business API).",
    properties: { video_id: VIDEO_ID_PROPERTY, comment_id: COMMENT_ID_PROPERTY, limit: LIMIT_PROPERTY },
    required: ["video_id", "comment_id"],
    path: "/business/comment/reply/list/",
    listKey: "comments",
    buildQuery: (args) => ({ video_id: args.video_id, comment_id: args.comment_id, max_count: args.limit }),
  }),
  defineBusinessWrite({
    name: "create_comment",
    title: "Comment on TikTok video",
    description: "Post a comment on one of the business account's videos (Business API).",
    properties: { video_id: VIDEO_ID_PROPERTY, text: { type: "string", minLength: 1 } },
    required: ["video_id", "text"],
    path: "/business/comment/create/",
    buildBody: (args) => ({ video_id: args.video_id, text: args.text }),
  }),
  defineBusinessWrite({
    name: "reply_to_comment",
    title: "Reply to TikTok comment",
    description: "Reply to a comment on one of the business account's videos (Business API).",
    properties: { video_id: VIDEO_ID_PROPERTY, comment_id: COMMENT_ID_PROPERTY, text: { type: "string", minLength: 1 } },
    required: ["video_id", "comment_id", "text"],
    path: "/business/comment/reply/create/",
    buildBody: (args) => ({ video_id: args.video_id, comment_id: args.comment_id, text: args.text }),
  }),
  defineBusinessWrite({
    name: "set_comment_hidden",
    title: "Hide/unhide TikTok comment",
    description: "Hide or unhide a comment on the business account's video (Business API).",
    properties: { comment_id: COMMENT_ID_PROPERTY, hidden: { type: "boolean" }, video_id: { ...VIDEO_ID_PROPERTY, description: "Video id, if the API asks for it" } },
    required: ["comment_id", "hidden"],
    path: "/business/comment/hide/",
    buildBody: (args) => ({ comment_id: args.comment_id, video_id: args.video_id, action: args.hidden ? "HIDE" : "UNHIDE" }),
  }),
  defineBusinessWrite({
    name: "set_comment_liked",
    title: "Like/unlike TikTok comment",
    description: "Like or unlike a comment as the business account (Business API).",
    properties: { comment_id: COMMENT_ID_PROPERTY, liked: { type: "boolean" } },
    required: ["comment_id", "liked"],
    path: "/business/comment/like/",
    buildBody: (args) => ({ comment_id: args.comment_id, action: args.liked ? "LIKE" : "UNLIKE" }),
  }),
  defineBusinessWrite({
    name: "delete_comment",
    title: "Delete TikTok comment",
    description: "Delete a comment the business account owns or that is on its video (Business API).",
    properties: { comment_id: COMMENT_ID_PROPERTY },
    required: ["comment_id"],
    path: "/business/comment/delete/",
    buildBody: (args) => ({ comment_id: args.comment_id }),
  }),
];

export const businessMessageOperations = [
  defineBusinessList({
    name: "list_conversations",
    title: "List TikTok conversations",
    description: "List direct-message conversations of the business account (Business API; restricted access).",
    properties: { conversation_type: CONVERSATION_TYPE_PROPERTY, limit: LIMIT_PROPERTY },
    path: "/business/message/conversation/list/",
    listKey: "conversations",
    buildQuery: (args) => ({ conversation_type: args.conversation_type, limit: args.limit }),
  }),
  defineBusinessList({
    name: "list_messages",
    title: "List TikTok messages",
    description: "List messages in one direct-message conversation (Business API; restricted access).",
    properties: { conversation_id: { type: "string", minLength: 1 }, conversation_type: CONVERSATION_TYPE_PROPERTY },
    required: ["conversation_id"],
    path: "/business/message/content/list/",
    listKey: "messages",
    buildQuery: (args) => ({ conversation_id: args.conversation_id, conversation_type: args.conversation_type }),
  }),
  defineBusinessWrite({
    name: "send_message",
    title: "Send TikTok message",
    description:
      "Send a text direct message as the business account (Business API; restricted access, only within 48 hours of the user's last message).",
    properties: {
      recipient: { type: "string", minLength: 1, description: "Conversation id (recipient_type CONVERSATION)" },
      recipient_type: { type: "string", enum: ["CONVERSATION"], default: "CONVERSATION" },
      text: { type: "string", minLength: 1 },
    },
    required: ["recipient", "text"],
    path: "/business/message/send/",
    buildBody: (args) => ({ recipient_type: args.recipient_type, recipient: args.recipient, message_type: "TEXT", text: { body: args.text } }),
  }),
];
