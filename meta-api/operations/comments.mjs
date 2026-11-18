/**
 * Facebook comment operations (on Page posts, photos and comments).
 */
import { pathSegment } from "../lib/shared/path.mjs";
import { paginationProperties, toPage } from "../lib/client.mjs";

const COMMENT_ID_PROPERTY = { type: "string", description: "Comment id" };
const DEFAULT_COMMENT_FIELDS = "id,message,created_time,from,like_count,comment_count,is_hidden,parent,attachment";

export const commentOperations = [
  {
    name: "list_comments",
    title: "List Facebook comments",
    description: "List comments on a Page post, photo or comment (use a comment id to list its replies).",
    parameters: {
      type: "object",
      properties: {
        object_id: { type: "string", description: "Post, photo or comment id" },
        filter: { type: "string", enum: ["toplevel", "stream"], default: "toplevel", description: "stream = all comments incl. replies" },
        order: { type: "string", enum: ["chronological", "reverse_chronological"] },
        fields: { type: "string", default: DEFAULT_COMMENT_FIELDS },
        ...paginationProperties(),
      },
      required: ["object_id"],
    },
    run: async ({ client, args, signal }) => {
      const responseBody = await client.request({
        path: `/${pathSegment(args.object_id)}/comments`,
        query: { filter: args.filter, order: args.order, fields: args.fields, summary: true, limit: args.limit, after: args.cursor },
        signal,
      });
      const commentPage = toPage(responseBody);
      return { data: { comments: commentPage.data, total_count: responseBody?.summary?.total_count ?? null }, next_cursor: commentPage.next_cursor };
    },
  },
  {
    name: "reply_to_comment",
    title: "Reply on Facebook",
    description: "Comment on a Page post or reply to a comment as the Page.",
    parameters: {
      type: "object",
      properties: {
        object_id: { type: "string", description: "Post id (new comment) or comment id (reply)" },
        message: { type: "string", minLength: 1 },
        attachment_url: { type: "string", description: "Optional image URL" },
      },
      required: ["object_id", "message"],
    },
    run: async ({ client, args, signal }) => ({
      data: await client.request({
        method: "POST",
        path: `/${pathSegment(args.object_id)}/comments`,
        form: { message: args.message, attachment_url: args.attachment_url },
        signal,
      }),
    }),
  },
  {
    name: "set_comment_hidden",
    title: "Hide/unhide Facebook comment",
    description: "Hide or unhide a comment on the Page.",
    parameters: { type: "object", properties: { comment_id: COMMENT_ID_PROPERTY, hidden: { type: "boolean" } }, required: ["comment_id", "hidden"] },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ method: "POST", path: `/${pathSegment(args.comment_id)}`, form: { is_hidden: args.hidden }, signal }),
    }),
  },
  {
    name: "delete_comment",
    title: "Delete Facebook comment",
    description: "Delete a comment on the Page.",
    parameters: { type: "object", properties: { comment_id: COMMENT_ID_PROPERTY }, required: ["comment_id"] },
    run: async ({ client, args, signal }) => ({ data: await client.request({ method: "DELETE", path: `/${pathSegment(args.comment_id)}`, signal }) }),
  },
  {
    name: "like_comment",
    title: "Like Facebook comment",
    description: "Like a comment as the Page.",
    parameters: { type: "object", properties: { comment_id: COMMENT_ID_PROPERTY }, required: ["comment_id"] },
    run: async ({ client, args, signal }) => ({ data: await client.request({ method: "POST", path: `/${pathSegment(args.comment_id)}/likes`, signal }) }),
  },
  {
    name: "unlike_comment",
    title: "Unlike Facebook comment",
    description: "Remove the Page's like from a comment.",
    parameters: { type: "object", properties: { comment_id: COMMENT_ID_PROPERTY }, required: ["comment_id"] },
    run: async ({ client, args, signal }) => ({ data: await client.request({ method: "DELETE", path: `/${pathSegment(args.comment_id)}/likes`, signal }) }),
  },
];
