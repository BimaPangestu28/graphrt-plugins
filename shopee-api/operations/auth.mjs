/**
 * Token refresh. Node only: refresh tokens and new access tokens must never pass through an LLM.
 */
import { extractShopeeResponse, readNumericEnv, redactPluginError, rejectInput } from "../lib/client.mjs";
import { requireIntegerId } from "../lib/validation.mjs";

export const authOperations = [
  {
    name: "refresh_access_token",
    nodeOnly: true,
    title: "Refresh Shopee access token",
    description:
      "Exchange the shop's refresh token for a new access token (valid 4 hours) and a new refresh token (valid 30 days, single use): store both. The partner key is read from SHOPEE_PARTNER_KEY only.",
    parameters: {
      type: "object",
      properties: {
        refresh_token: { type: "string", description: "Refresh token (default: SHOPEE_REFRESH_TOKEN)" },
        shop_id: { type: "string", description: "Shop id (default: SHOPEE_SHOP_ID)" },
      },
    },
    run: refreshAccessToken,
  },
];

async function refreshAccessToken({ client, args, environment, signal }) {
  const refreshToken = args.refresh_token || environment?.SHOPEE_REFRESH_TOKEN;
  if (!refreshToken) rejectInput("Pass `refresh_token` or set the SHOPEE_REFRESH_TOKEN environment variable");
  const shopId = requireIntegerId("shop_id", args.shop_id ?? readNumericEnv(environment, "SHOPEE_SHOP_ID"));
  const partnerId = Number(client.public.readPartnerId());
  const json = { refresh_token: refreshToken, partner_id: partnerId, shop_id: shopId };
  try {
    const body = await client.public.request({ method: "POST", path: "/api/v2/auth/access_token/get", json, secrets: [refreshToken], signal });
    return { data: extractShopeeResponse(body) };
  } catch (error) {
    throw redactPluginError(error, [refreshToken, environment?.SHOPEE_PARTNER_KEY]);
  }
}
