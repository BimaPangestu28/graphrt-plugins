/**
 * Threads post operations: list own threads/replies, mentions, keyword
 * search, repost and delete.
 */
import { pathSegment } from "../lib/shared/path.mjs";
import { paginationProperties, toPage } from "../lib/client.mjs";

export const DEFAULT_MEDIA_FIELDS =
  "id,media_product_type,media_type,media_url,permalink,username,text,timestamp,shortcode,thumbnail_url,is_quote_post,has_replies";
const MEDIA_ID_PROPERTY = { type: "string", description: "Threads media (post) id" };
const TIME_RANGE_PROPERTIES = {
  since: { type: "string", description: "Only posts after this time (Unix timestamp or strtotime value)" },
  until: { type: "string", description: "Only posts before this time (Unix timestamp or strtotime value)" },
};
const LIST_PROPERTIES = { fields: { type: "string", default: DEFAULT_MEDIA_FIELDS }, ...TIME_RANGE_PROPERTIES, ...paginationProperties() };

/**
 * Builds the query shared by media list endpoints.
 *
 * @param args - Validated arguments with fields, since, until, limit, cursor (object)
 * @returns Query parameters (object)
 */
export function buildListQuery(args) {
  return { fields: args.fields, since: args.since, until: args.until, limit: args.limit, after: args.cursor };
}

const listFromPath = (path) => async ({ client, args, signal }) => toPage(await client.request({ path, query: buildListQuery(args), signal }));

export const postOperations = [
  {
    name: "list_threads",
    title: "List Threads posts",
    description: "List threads published by the account (or another user id the token can read), newest first.",
    parameters: {
      type: "object",
      properties: { user_id: { type: "string", default: "me", description: "Threads user id (default: me)" }, ...LIST_PROPERTIES },
    },
    run: async ({ client, args, signal }) =>
      toPage(await client.request({ path: `/${pathSegment(args.user_id)}/threads`, query: buildListQuery(args), signal })),
  },
  {
    name: "list_my_replies",
    title: "List my Threads replies",
    description: "List replies the account has posted, newest first.",
    parameters: { type: "object", properties: LIST_PROPERTIES },
    run: listFromPath("/me/replies"),
  },
  {
    name: "list_mentions",
    title: "List Threads mentions",
    description: "List public posts that mention the account (needs threads_manage_mentions).",
    parameters: { type: "object", properties: LIST_PROPERTIES },
    run: listFromPath("/me/mentions"),
  },
  {
    name: "keyword_search",
    title: "Search Threads",
    description: "Search public Threads posts by keyword or topic tag (needs threads_keyword_search).",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", minLength: 1, description: "Keyword or topic tag to search for" },
        search_type: { type: "string", enum: ["TOP", "RECENT"], default: "TOP" },
        search_mode: { type: "string", enum: ["KEYWORD", "TAG"], default: "KEYWORD" },
        ...LIST_PROPERTIES,
      },
      required: ["q"],
    },
    run: async ({ client, args, signal }) => {
      const query = { q: args.q, search_type: args.search_type, search_mode: args.search_mode, ...buildListQuery(args) };
      return toPage(await client.request({ path: "/keyword_search", query, signal }));
    },
  },
  {
    name: "repost_thread",
    title: "Repost thread",
    description: "Repost a Threads post to the account's profile. Returns the repost id.",
    parameters: { type: "object", properties: { media_id: MEDIA_ID_PROPERTY }, required: ["media_id"] },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ method: "POST", path: `/${pathSegment(args.media_id)}/repost`, signal }),
    }),
  },
  {
    name: "delete_thread",
    title: "Delete thread",
    description: "Delete one of the account's Threads posts or replies (needs threads_delete).",
    parameters: { type: "object", properties: { media_id: MEDIA_ID_PROPERTY }, required: ["media_id"] },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ method: "DELETE", path: `/${pathSegment(args.media_id)}`, signal }),
    }),
  },
];
