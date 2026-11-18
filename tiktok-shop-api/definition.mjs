/**
 * tiktok-shop-api plugin definition: the TikTok Shop Partner API (202309+ versioned endpoints) for one shop:
 * authorized shops, products, inventory and prices, orders, fulfilment, returns and customer service, plus
 * token refresh. Every Open API request is signed with the app secret.
 *
 * Operations receive `client = {shop, auth}` (see lib/client.mjs). The access token is resolved without failing,
 * so `refresh_access_token` works when only the refresh token is set.
 */
import { createTiktokShopClients, resolveTiktokShopAccessToken } from "./lib/client.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { authOperations } from "./operations/auth.mjs";
import { customerServiceOperations } from "./operations/customer-service.mjs";
import { orderOperations } from "./operations/orders.mjs";
import { productOperations } from "./operations/products.mjs";

const SHOP_CIPHER_SELECTOR = {
  include_shop_cipher: {
    type: "boolean",
    default: true,
    description: "Add shop_cipher (TIKTOK_SHOP_CIPHER) to the query; set false for app-level endpoints such as /authorization/202309/shops",
  },
};

export const pluginDefinition = {
  name: "tiktok-shop-api",
  version: "0.1.0",
  description: "TikTok Shop seller API (Partner API 202309+): products, inventory and prices, orders, shipping, returns and buyer messages",
  tokenEnv: "TIKTOK_SHOP_ACCESS_TOKEN",
  extraEnv: ["TIKTOK_SHOP_APP_KEY", "TIKTOK_SHOP_APP_SECRET", "TIKTOK_SHOP_REFRESH_TOKEN", "TIKTOK_SHOP_CIPHER"],
  createClient: createTiktokShopClients,
  resolveAccessToken: resolveTiktokShopAccessToken,
  operations: [
    ...productOperations,
    ...orderOperations,
    ...customerServiceOperations,
    ...authOperations,
    createApiRequestOperation({
      apiName: "TikTok Shop API",
      examplePath: "/logistics/202309/warehouses",
      extraProperties: SHOP_CIPHER_SELECTOR,
      selectClient: (client, args) => ({
        request: (requestOptions) => client.shop.request({ ...requestOptions, includeShopCipher: args.include_shop_cipher }),
      }),
    }),
  ],
};
