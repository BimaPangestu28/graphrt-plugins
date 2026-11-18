/**
 * LinkedIn comment and reaction operations (socialActions and reactions APIs).
 */
import { encodeRestliValue, paginationProperties, rejectInput, requireUrn, resolveActorUrn, toPage, toPagingQuery } from "../lib/client.mjs";

const TARGET_URN_PROPERTY = {
  type: "string",
  description: 'Post or comment URN, e.g. "urn:li:share:123", "urn:li:ugcPost:123" or "urn:li:comment:(urn:li:activity:1,2)"',
};
const ACTOR_PROPERTY = { type: "string", description: "urn:li:person:... or urn:li:organization:... acting (default: LINKEDIN_AUTHOR_URN)" };
const COMMENT_ID_PROPERTY = { type: "string", description: 'Comment id, or its full URN "urn:li:comment:(urn:li:activity:1,2)"' };
const COMMENT_TEXT_PROPERTY = { type: "string", minLength: 1, description: "Comment text" };
const REACTION_TYPES = ["LIKE", "PRAISE", "EMPATHY", "INTEREST", "APPRECIATION", "ENTERTAINMENT"];
const COMMENT_URN_PATTERN = /^urn:li:comment:\(.+,([^,()]+)\)$/;
const COMMENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Extracts the comment id from a bare id or a comment URN.
 *
 * @param commentIdOrUrn - "456" or "urn:li:comment:(urn:li:activity:123,456)" (string)
 * @returns The comment id (string)
 * @throws PluginError kind `invalid_input` - When it is neither
 */
export function toCommentId(commentIdOrUrn) {
  const urnMatch = COMMENT_URN_PATTERN.exec(commentIdOrUrn);
  const commentId = urnMatch ? urnMatch[1] : commentIdOrUrn;
  if (!COMMENT_ID_PATTERN.test(commentId)) rejectInput(`\`comment_id\` must be a comment id or comment URN, got "${commentIdOrUrn}"`);
  return commentId;
}

const commentsPath = (targetUrn) => `/socialActions/${encodeRestliValue(requireUrn(targetUrn, "target_urn"))}/comments`;
const commentPath = (args) => `${commentsPath(args.target_urn)}/${encodeRestliValue(toCommentId(args.comment_id))}`;

function withRestliId(responseBody, headers) {
  const restliId = headers.get("x-restli-id");
  const body = responseBody && typeof responseBody === "object" ? responseBody : {};
  return body.id || !restliId ? body : { ...body, id: restliId };
}

async function createComment({ client, args, environment, signal }) {
  const actorUrn = resolveActorUrn(args.actor, environment, "actor");
  const objectUrn = requireUrn(args.target_urn, "target_urn");
  const parentCommentUrn = args.parent_comment_urn ? requireUrn(args.parent_comment_urn, "parent_comment_urn") : undefined;
  const commentBody = { actor: actorUrn, object: objectUrn, message: { text: args.text }, parentComment: parentCommentUrn };
  // Replies are created under the parent comment's socialActions, with `object` still the post.
  const { body, headers } = await client.requestWithHeaders({
    method: "POST",
    path: commentsPath(parentCommentUrn ?? objectUrn),
    json: commentBody,
    signal,
  });
  return { data: withRestliId(body, headers) };
}

async function addReaction({ client, args, environment, signal }) {
  const actorUrn = resolveActorUrn(args.actor, environment, "actor");
  const { body, headers } = await client.requestWithHeaders({
    method: "POST",
    path: "/reactions",
    query: { actor: actorUrn },
    json: { root: requireUrn(args.target_urn, "target_urn"), reactionType: args.reaction_type },
    signal,
  });
  return { data: withRestliId(body, headers) };
}

async function listReactions({ client, args, signal }) {
  const pagingQuery = toPagingQuery(args);
  const entityKey = encodeRestliValue(requireUrn(args.target_urn, "target_urn"));
  const responseBody = await client.request({
    path: `/reactions/(entity:${entityKey})`,
    query: { q: "entity", sort: args.sort, ...pagingQuery },
    headers: { "x-restli-method": "FINDER" },
    signal,
  });
  return toPage(responseBody, pagingQuery);
}

export const engagementOperations = [
  {
    name: "list_comments",
    title: "List LinkedIn comments",
    description: "List comments on a post, or replies to a comment (pass the comment URN as target_urn).",
    parameters: { type: "object", properties: { target_urn: TARGET_URN_PROPERTY, ...paginationProperties() }, required: ["target_urn"] },
    run: async ({ client, args, signal }) => {
      const pagingQuery = toPagingQuery(args);
      return toPage(await client.request({ path: commentsPath(args.target_urn), query: pagingQuery, signal }), pagingQuery);
    },
  },
  {
    name: "create_comment",
    title: "Comment on LinkedIn",
    description: "Comment on a post, or reply to a comment with parent_comment_urn.",
    parameters: {
      type: "object",
      properties: {
        target_urn: { type: "string", description: "Post URN the comment belongs to" },
        text: COMMENT_TEXT_PROPERTY,
        actor: ACTOR_PROPERTY,
        parent_comment_urn: { type: "string", description: "Comment URN to reply to (nested comment)" },
      },
      required: ["target_urn", "text"],
    },
    run: createComment,
  },
  {
    name: "update_comment",
    title: "Edit LinkedIn comment",
    description: "Edit the text of a comment made by the actor.",
    parameters: {
      type: "object",
      properties: { target_urn: TARGET_URN_PROPERTY, comment_id: COMMENT_ID_PROPERTY, text: COMMENT_TEXT_PROPERTY, actor: ACTOR_PROPERTY },
      required: ["target_urn", "comment_id", "text"],
    },
    run: async ({ client, args, environment, signal }) => ({
      data: await client.request({
        method: "POST",
        path: commentPath(args),
        query: { actor: resolveActorUrn(args.actor, environment, "actor") },
        json: { patch: { message: { $set: { text: args.text } } } },
        headers: { "x-restli-method": "PARTIAL_UPDATE" },
        signal,
      }),
    }),
  },
  {
    name: "delete_comment",
    title: "Delete LinkedIn comment",
    description: "Delete a comment (the actor's own, or one on the actor's organization post).",
    parameters: {
      type: "object",
      properties: { target_urn: TARGET_URN_PROPERTY, comment_id: COMMENT_ID_PROPERTY, actor: ACTOR_PROPERTY },
      required: ["target_urn", "comment_id"],
    },
    run: async ({ client, args, environment, signal }) => {
      const actorUrn = resolveActorUrn(args.actor, environment, "actor");
      const path = commentPath(args);
      await client.request({ method: "DELETE", path, query: { actor: actorUrn }, headers: { "x-restli-method": "DELETE" }, signal });
      return { data: { comment_id: toCommentId(args.comment_id), deleted: true } };
    },
  },
  {
    name: "add_reaction",
    title: "React on LinkedIn",
    description: "React to a post or comment (LIKE, PRAISE, EMPATHY, INTEREST, APPRECIATION, ENTERTAINMENT).",
    parameters: {
      type: "object",
      properties: { target_urn: TARGET_URN_PROPERTY, reaction_type: { type: "string", enum: REACTION_TYPES, default: "LIKE" }, actor: ACTOR_PROPERTY },
      required: ["target_urn"],
    },
    run: addReaction,
  },
  {
    name: "remove_reaction",
    title: "Remove LinkedIn reaction",
    description: "Remove the actor's reaction from a post or comment.",
    parameters: { type: "object", properties: { target_urn: TARGET_URN_PROPERTY, actor: ACTOR_PROPERTY }, required: ["target_urn"] },
    run: async ({ client, args, environment, signal }) => {
      const actorKey = encodeRestliValue(resolveActorUrn(args.actor, environment, "actor"));
      const entityKey = encodeRestliValue(requireUrn(args.target_urn, "target_urn"));
      await client.request({ method: "DELETE", path: `/reactions/(actor:${actorKey},entity:${entityKey})`, headers: { "x-restli-method": "DELETE" }, signal });
      return { data: { target_urn: args.target_urn, removed: true } };
    },
  },
  {
    name: "list_reactions",
    title: "List LinkedIn reactions",
    description: "List reactions on a post or comment.",
    parameters: {
      type: "object",
      properties: {
        target_urn: TARGET_URN_PROPERTY,
        sort: { type: "string", enum: ["CHRONOLOGICAL", "REVERSE_CHRONOLOGICAL", "RELEVANCE"] },
        ...paginationProperties(),
      },
      required: ["target_urn"],
    },
    run: listReactions,
  },
];
