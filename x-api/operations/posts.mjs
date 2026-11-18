/**
 * Post operations: create, delete, read, timelines, mentions and search.
 */
import { rejectInput, resolveAuthenticatedUserId, toPage } from "../lib/client.mjs";
import { mergeQueryParams, numericIdProperty, paginationProperties, QUERY_PARAMS_PROPERTY } from "../lib/parameters.mjs";

const POST_ID_PROPERTY = numericIdProperty("Post id");
const MIN_POLL_MINUTES = 5;
const MAX_POLL_MINUTES = 10080;
const MAX_POLL_OPTION_CHARACTERS = 25;
const REPLY_SETTINGS = ["following", "mentionedUsers", "subscribers", "verified"];

function buildPostBody(args) {
  const hasPoll = args.poll_options !== undefined || args.poll_duration_minutes !== undefined;
  if (!args.text && !args.media_ids?.length) rejectInput("Pass `text`, `media_ids` or both");
  if (hasPoll) checkPoll(args);
  return {
    text: args.text,
    reply: args.reply_to_post_id ? { in_reply_to_tweet_id: args.reply_to_post_id } : undefined,
    quote_tweet_id: args.quote_post_id,
    media: args.media_ids?.length ? { media_ids: args.media_ids } : undefined,
    poll: hasPoll ? { options: args.poll_options, duration_minutes: args.poll_duration_minutes } : undefined,
    reply_settings: args.reply_settings,
  };
}

function checkPoll(args) {
  if (args.media_ids?.length) rejectInput("A post cannot have both a poll and media");
  const optionCount = args.poll_options?.length ?? 0;
  if (optionCount < 2 || optionCount > 4) rejectInput("`poll_options` needs 2 to 4 options");
  if (!args.poll_options.every(isValidPollOption)) rejectInput(`Each of \`poll_options\` must be 1-${MAX_POLL_OPTION_CHARACTERS} characters`);
  const duration = args.poll_duration_minutes;
  if (duration === undefined || duration < MIN_POLL_MINUTES || duration > MAX_POLL_MINUTES) {
    rejectInput(`\`poll_duration_minutes\` is required with a poll and must be ${MIN_POLL_MINUTES}-${MAX_POLL_MINUTES}`);
  }
}

// Counted in code points, so an emoji is one character as X counts it.
function isValidPollOption(pollOption) {
  return pollOption.trim() !== "" && [...pollOption].length <= MAX_POLL_OPTION_CHARACTERS;
}

async function listUserTimeline({ client, args, signal }, timelineName) {
  const userId = args.user_id ?? (await resolveAuthenticatedUserId(client, signal));
  const query = mergeQueryParams(args.query_params, { max_results: args.limit, pagination_token: args.cursor, exclude: args.exclude });
  return toPage(await client.request({ path: `/2/users/${userId}/${timelineName}`, query, signal }));
}

function searchRecent({ client, args, signal }, searchQuery) {
  const query = mergeQueryParams(args.query_params, { query: searchQuery, max_results: args.limit, next_token: args.cursor, sort_order: args.sort_order });
  return client.request({ path: "/2/tweets/search/recent", query, signal }).then(toPage);
}

export const postOperations = [
  {
    name: "create_post",
    title: "Create X post",
    description: "Publish a post (tweet): text, reply, quote, media (ids from upload_media) or a poll.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Post text" },
        reply_to_post_id: numericIdProperty("Post id to reply to"),
        quote_post_id: numericIdProperty("Post id to quote"),
        media_ids: { type: "array", items: { type: "string", pattern: "^[0-9]{1,19}$" }, maxItems: 4, description: "Media ids from upload_media (up to 4)" },
        poll_options: { type: "array", items: { type: "string" }, maxItems: 4, description: "2-4 poll choices (1-25 characters each)" },
        poll_duration_minutes: { type: "integer", description: `Poll length, ${MIN_POLL_MINUTES}-${MAX_POLL_MINUTES} minutes` },
        reply_settings: { type: "string", enum: REPLY_SETTINGS, description: "Who can reply (default: everyone)" },
      },
    },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ method: "POST", path: "/2/tweets", json: buildPostBody(args), signal }),
    }),
  },
  {
    name: "delete_post",
    title: "Delete X post",
    description: "Delete one of the authenticated user's posts.",
    parameters: { type: "object", properties: { post_id: POST_ID_PROPERTY }, required: ["post_id"] },
    run: async ({ client, args, signal }) => ({ data: await client.request({ method: "DELETE", path: `/2/tweets/${args.post_id}`, signal }) }),
  },
  {
    name: "get_post",
    title: "Get X post",
    description: "Read a post by id. Use query_params for tweet.fields/expansions.",
    parameters: { type: "object", properties: { post_id: POST_ID_PROPERTY, query_params: QUERY_PARAMS_PROPERTY }, required: ["post_id"] },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ path: `/2/tweets/${args.post_id}`, query: mergeQueryParams(args.query_params, {}), signal }),
    }),
  },
  {
    name: "list_user_posts",
    title: "List X user posts",
    description: "List a user's posts, newest first (default: the authenticated user).",
    parameters: {
      type: "object",
      properties: {
        user_id: numericIdProperty("User id (default: X_USER_ID or the authenticated user)"),
        exclude: { type: "array", items: { type: "string", enum: ["replies", "retweets"] }, description: "Post types to leave out" },
        query_params: QUERY_PARAMS_PROPERTY,
        ...paginationProperties({ minimum: 5 }),
      },
    },
    run: (runContext) => listUserTimeline(runContext, "tweets"),
  },
  {
    name: "list_mentions",
    title: "List X mentions",
    description: "List posts mentioning a user, newest first (default: the authenticated user).",
    parameters: {
      type: "object",
      properties: {
        user_id: numericIdProperty("User id (default: X_USER_ID or the authenticated user)"),
        query_params: QUERY_PARAMS_PROPERTY,
        ...paginationProperties({ minimum: 5 }),
      },
    },
    run: (runContext) => listUserTimeline(runContext, "mentions"),
  },
  {
    name: "search_recent_posts",
    title: "Search recent X posts",
    description: "Search posts from the last 7 days with X search syntax, e.g. \"from:XDevelopers -is:retweet\".",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "X search query" },
        sort_order: { type: "string", enum: ["recency", "relevancy"] },
        query_params: QUERY_PARAMS_PROPERTY,
        ...paginationProperties({ minimum: 10 }),
      },
      required: ["query"],
    },
    run: (runContext) => searchRecent(runContext, runContext.args.query),
  },
  {
    name: "list_replies",
    title: "List X replies",
    description: "List replies in a post's conversation from the last 7 days (recent search on conversation_id).",
    parameters: {
      type: "object",
      properties: {
        post_id: numericIdProperty("Conversation root post id"),
        sort_order: { type: "string", enum: ["recency", "relevancy"] },
        query_params: QUERY_PARAMS_PROPERTY,
        ...paginationProperties({ minimum: 10 }),
      },
      required: ["post_id"],
    },
    run: (runContext) => searchRecent(runContext, `conversation_id:${runContext.args.post_id}`),
  },
];
