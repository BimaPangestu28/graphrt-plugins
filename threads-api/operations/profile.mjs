/**
 * Threads profile and account operations: own profile, public profile lookup,
 * publishing quota and long-lived token refresh.
 */

const DEFAULT_PROFILE_FIELDS = "id,username,name,threads_profile_picture_url,threads_biography,is_verified";
const PUBLISHING_LIMIT_FIELDS = "quota_usage,config,reply_quota_usage,reply_config,delete_quota_usage,delete_config";

export const profileOperations = [
  {
    name: "get_profile",
    title: "Get Threads profile",
    description: "Read the authenticated Threads profile (id, username, name, bio, picture, verification).",
    parameters: { type: "object", properties: { fields: { type: "string", default: DEFAULT_PROFILE_FIELDS } } },
    run: async ({ client, args, signal }) => ({ data: await client.request({ path: "/me", query: { fields: args.fields }, signal }) }),
  },
  {
    name: "lookup_profile",
    title: "Look up Threads profile",
    description: "Look up a public Threads profile by username (needs threads_profile_discovery).",
    parameters: {
      type: "object",
      properties: { username: { type: "string", minLength: 1, description: "Threads username without @" } },
      required: ["username"],
    },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ path: "/profile_lookup", query: { username: args.username.replace(/^@/, "") }, signal }),
    }),
  },
  {
    name: "get_publishing_limit",
    title: "Get Threads publishing limit",
    description: "Read the account's 24-hour quota usage for posts, replies and deletes.",
    parameters: { type: "object", properties: {} },
    run: async ({ client, signal }) => ({
      data: await client.request({ path: "/me/threads_publishing_limit", query: { fields: PUBLISHING_LIMIT_FIELDS }, signal }),
    }),
  },
  {
    name: "refresh_access_token",
    title: "Refresh Threads access token",
    description:
      "Exchange the current long-lived token (at least 24 hours old, not expired) for a new 60-day token. Returns {access_token, token_type, expires_in}; store the new token yourself.",
    parameters: { type: "object", properties: {} },
    run: async ({ client, signal }) => ({ data: await client.refreshAccessToken({ signal }) }),
  },
];
