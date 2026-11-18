/**
 * Threads reply moderation: list replies or the full conversation, hide
 * replies, and approve or ignore pending replies.
 */
import { pathSegment } from "../lib/shared/path.mjs";
import { paginationProperties, toPage } from "../lib/client.mjs";

const DEFAULT_REPLY_FIELDS = "id,text,username,permalink,timestamp,media_type,has_replies,is_reply,root_post,replied_to,hide_status";
const MEDIA_ID_PROPERTY = { type: "string", description: "Threads media (post) id" };
const REPLY_ID_PROPERTY = { type: "string", description: "Reply id" };
const REPLY_LIST_PROPERTIES = {
  media_id: MEDIA_ID_PROPERTY,
  fields: { type: "string", default: DEFAULT_REPLY_FIELDS },
  reverse: { type: "boolean", default: false, description: "true lists oldest first" },
  ...paginationProperties(),
};

const buildReplyListQuery = (args) => ({ fields: args.fields, reverse: args.reverse, limit: args.limit, after: args.cursor });

export const replyOperations = [
  {
    name: "list_replies",
    title: "List Threads replies",
    description:
      "List replies to a Threads post. With conversation=true, list every reply at every depth in the conversation instead of only top-level replies.",
    parameters: {
      type: "object",
      properties: { ...REPLY_LIST_PROPERTIES, conversation: { type: "boolean", default: false, description: "Use /conversation (all depths)" } },
      required: ["media_id"],
    },
    run: async ({ client, args, signal }) => {
      const edge = args.conversation ? "conversation" : "replies";
      return toPage(await client.request({ path: `/${pathSegment(args.media_id)}/${edge}`, query: buildReplyListQuery(args), signal }));
    },
  },
  {
    name: "hide_reply",
    title: "Hide/unhide Threads reply",
    description: "Hide or unhide a reply under one of the account's posts (needs threads_manage_replies).",
    parameters: { type: "object", properties: { reply_id: REPLY_ID_PROPERTY, hidden: { type: "boolean" } }, required: ["reply_id", "hidden"] },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ method: "POST", path: `/${pathSegment(args.reply_id)}/manage_reply`, form: { hide: args.hidden }, signal }),
    }),
  },
  {
    name: "list_pending_replies",
    title: "List pending Threads replies",
    description: "List replies awaiting approval on a post that uses reply approvals.",
    parameters: {
      type: "object",
      properties: { ...REPLY_LIST_PROPERTIES, approval_status: { type: "string", enum: ["pending", "ignored"], default: "pending" } },
      required: ["media_id"],
    },
    run: async ({ client, args, signal }) => {
      const query = { ...buildReplyListQuery(args), approval_status: args.approval_status };
      return toPage(await client.request({ path: `/${pathSegment(args.media_id)}/pending_replies`, query, signal }));
    },
  },
  {
    name: "approve_pending_reply",
    title: "Approve/ignore pending Threads reply",
    description: "Approve (approve=true) or ignore (approve=false) a pending reply.",
    parameters: { type: "object", properties: { reply_id: REPLY_ID_PROPERTY, approve: { type: "boolean" } }, required: ["reply_id", "approve"] },
    run: async ({ client, args, signal }) => ({
      data: await client.request({
        method: "POST",
        path: `/${pathSegment(args.reply_id)}/manage_pending_reply`,
        form: { approve: args.approve },
        signal,
      }),
    }),
  },
];
