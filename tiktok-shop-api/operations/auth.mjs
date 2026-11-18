/**
 * Token refresh. Node only: refresh tokens and new access tokens must never pass through an LLM.
 */
import { rejectInput } from "../lib/client.mjs";

export const authOperations = [
  {
    name: "refresh_access_token",
    nodeOnly: true,
    title: "Refresh TikTok Shop access token",
    description:
      "Exchange the refresh token for a new access token (auth.tiktok-shops.com) and store the returned access_token and refresh_token. The app secret is read from TIKTOK_SHOP_APP_SECRET only.",
    parameters: {
      type: "object",
      properties: { refresh_token: { type: "string", description: "Refresh token (default: TIKTOK_SHOP_REFRESH_TOKEN)" } },
    },
    run: async ({ client, args, environment, signal }) => {
      const refreshToken = args.refresh_token || environment?.TIKTOK_SHOP_REFRESH_TOKEN;
      if (!refreshToken) rejectInput("Pass `refresh_token` or set the TIKTOK_SHOP_REFRESH_TOKEN environment variable");
      const body = await client.auth.refreshToken(refreshToken, signal);
      return { data: body?.data ?? null };
    },
  },
];
