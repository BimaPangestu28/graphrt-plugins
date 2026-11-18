/**
 * shopee-api plugin definition: the Shopee Open Platform v2 shop APIs (shop, products, orders, logistics,
 * seller chat) and token refresh, every request signed with the app's partner key.
 *
 * Operations receive `client = {shop, public}` (see lib/client.mjs). The access token is resolved without
 * failing, so `refresh_access_token` works when only the refresh token is set.
 */
import { createShopeeClients, resolveShopeeAccessToken } from "./lib/client.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { authOperations } from "./operations/auth.mjs";
import { chatOperations } from "./operations/chat.mjs";
import { orderOperations } from "./operations/orders.mjs";
import { productOperations } from "./operations/products.mjs";

const API_TYPE_PROPERTY = {
  api_type: {
    type: "string",
    enum: ["shop", "public"],
    default: "shop",
    description: "shop = signed with access_token and shop_id (most APIs); public = partner-level APIs signed without them",
  },
};

export const pluginDefinition = {
  name: "shopee-api",
  version: "0.1.0",
  description: "Shopee seller shop via the Shopee Open Platform v2: products, stock and prices, orders, shipping and seller chat",
  tokenEnv: "SHOPEE_ACCESS_TOKEN",
  extraEnv: ["SHOPEE_PARTNER_ID", "SHOPEE_PARTNER_KEY", "SHOPEE_SHOP_ID", "SHOPEE_REFRESH_TOKEN", "SHOPEE_ENV"],
  createClient: createShopeeClients,
  resolveAccessToken: resolveShopeeAccessToken,
  operations: [
    ...productOperations,
    ...orderOperations,
    ...chatOperations,
    ...authOperations,
    createApiRequestOperation({
      apiName: "Shopee Open Platform v2",
      examplePath: "/api/v2/product/get_category",
      extraProperties: API_TYPE_PROPERTY,
      selectClient: (client, args) => client[args.api_type],
    }),
  ],
};
