/**
 * Open API account operations: profile, video list/query, creator info and
 * OAuth token refresh.
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { redactPluginError, rejectInput, toCursorPage } from "../lib/client.mjs";

const DEFAULT_USER_FIELDS =
  "open_id,union_id,avatar_url,display_name,bio_description,profile_deep_link,is_verified,username,follower_count,following_count,likes_count,video_count";
const DEFAULT_VIDEO_FIELDS =
  "id,title,video_description,create_time,cover_image_url,share_url,duration,height,width,embed_link,like_count,comment_count,share_count,view_count";
const MAX_VIDEOS_PER_REQUEST = 20;
const NUMERIC_CURSOR_PATTERN = /^\d+$/;

export const accountOperations = [
  {
    name: "get_user_info",
    title: "Get TikTok user info",
    description: "Read the authorized TikTok user's profile (display name, username, follower and video counts). Fields need the matching user.info.* scopes.",
    parameters: { type: "object", properties: { fields: { type: "string", default: DEFAULT_USER_FIELDS, description: "Comma-separated user fields" } } },
    run: async ({ client, args, signal }) => {
      const responseBody = await client.open.request({ path: "/v2/user/info/", query: { fields: args.fields }, signal });
      return { data: responseBody?.data?.user ?? null };
    },
  },
  {
    name: "list_videos",
    title: "List TikTok videos",
    description: "List the authorized user's public videos, newest first (scope video.list).",
    parameters: {
      type: "object",
      properties: {
        fields: { type: "string", default: DEFAULT_VIDEO_FIELDS, description: "Comma-separated video fields" },
        limit: { type: "integer", minimum: 1, maximum: MAX_VIDEOS_PER_REQUEST, default: MAX_VIDEOS_PER_REQUEST, description: "Page size (max 20)" },
        cursor: { type: "string", description: "next_cursor from a previous call" },
      },
    },
    run: async ({ client, args, signal }) => {
      const requestBody = { max_count: args.limit, ...(args.cursor !== undefined && { cursor: parseVideoCursor(args.cursor) }) };
      const responseBody = await client.open.request({ method: "POST", path: "/v2/video/list/", query: { fields: args.fields }, json: requestBody, signal });
      return toCursorPage(responseBody?.data, "videos");
    },
  },
  {
    name: "query_videos",
    title: "Query TikTok videos",
    description: "Read specific videos of the authorized user by id (up to 20), e.g. to refresh their counts.",
    parameters: {
      type: "object",
      properties: {
        video_ids: { type: "array", items: { type: "string" }, maxItems: MAX_VIDEOS_PER_REQUEST, description: "1-20 video ids" },
        fields: { type: "string", default: DEFAULT_VIDEO_FIELDS, description: "Comma-separated video fields" },
      },
      required: ["video_ids"],
    },
    run: async ({ client, args, signal }) => {
      if (args.video_ids.length === 0) rejectInput("`video_ids` needs at least one id");
      const responseBody = await client.open.request({
        method: "POST",
        path: "/v2/video/query/",
        query: { fields: args.fields },
        json: { filters: { video_ids: args.video_ids } },
        signal,
      });
      return { data: responseBody?.data?.videos ?? [] };
    },
  },
  {
    name: "get_creator_info",
    title: "Get TikTok creator info",
    description: "Read the creator's posting settings: allowed privacy levels, whether comments/duet/stitch are disabled, and max video duration.",
    parameters: { type: "object", properties: {} },
    run: async ({ client, signal }) => ({ data: await queryCreatorInfo(client, signal) }),
  },
  {
    name: "refresh_access_token",
    title: "Refresh TikTok access token",
    description:
      "Exchange a refresh token for a new access token. TikTok rotates refresh tokens: store the returned refresh_token. The client secret is read from TIKTOK_CLIENT_SECRET only.",
    parameters: {
      type: "object",
      properties: {
        refresh_token: { type: "string", description: "Refresh token (default: TIKTOK_REFRESH_TOKEN)" },
        client_key: { type: "string", description: "App client key (default: TIKTOK_CLIENT_KEY)" },
      },
    },
    run: refreshAccessToken,
  },
];

/**
 * Reads creator_info (posting settings and allowed privacy levels).
 *
 * @param client - Plugin clients `{open}` (object)
 * @param signal - Cancellation signal (AbortSignal)
 * @returns The creator info `data` object (Promise<object>)
 */
export async function queryCreatorInfo(client, signal) {
  const responseBody = await client.open.request({ method: "POST", path: "/v2/post/publish/creator_info/query/", json: {}, signal });
  return responseBody?.data ?? {};
}

function parseVideoCursor(cursor) {
  if (!NUMERIC_CURSOR_PATTERN.test(cursor)) rejectInput("`cursor` must be the numeric next_cursor returned by list_videos");
  return Number(cursor);
}

async function refreshAccessToken({ client, args, environment, signal }) {
  const refreshToken = args.refresh_token || environment?.TIKTOK_REFRESH_TOKEN;
  const clientKey = args.client_key || environment?.TIKTOK_CLIENT_KEY;
  const clientSecret = environment?.TIKTOK_CLIENT_SECRET;
  if (!refreshToken) rejectInput("Pass `refresh_token` or set the TIKTOK_REFRESH_TOKEN environment variable");
  if (!clientKey) rejectInput("Pass `client_key` or set the TIKTOK_CLIENT_KEY environment variable");
  if (!clientSecret) {
    throw new PluginError("Refreshing needs the app secret: set the TIKTOK_CLIENT_SECRET environment variable", { kind: "auth_error" });
  }
  const tokenForm = { grant_type: "refresh_token", refresh_token: refreshToken, client_key: clientKey, client_secret: clientSecret };
  try {
    return { data: await client.oauth.request({ method: "POST", path: "/v2/oauth/token/", form: tokenForm, signal }) };
  } catch (error) {
    throw redactPluginError(error, [refreshToken, clientSecret]);
  }
}
