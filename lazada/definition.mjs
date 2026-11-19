/**
 * lazada plugin definition: the Lazada Open Platform seller APIs (seller, products, orders, order items) plus price,
 * stock and fulfilment writes, every request signed with the app secret (HMAC-SHA256, lib/signing.mjs) and sent to
 * the seller's regional gateway (LAZADA_REGION).
 *
 * Hand-written rather than declarative: the signature goes into the query string and covers the form body, which
 * the declarative layer's custom auth (headers only) cannot express.
 *
 * Agent policy: reads are tools; price, stock, pack and ready-to-ship are node only (same ruling as shopee-api);
 * api_request is GET-only for tools and limited to read paths (lib/tool-path-allowlist.mjs).
 */
import { createLazadaClient } from "./lib/client.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { limitToolApiPaths } from "./lib/tool-path-allowlist.mjs";
import { readOperations } from "./operations/reads.mjs";
import { writeOperations } from "./operations/writes.mjs";

const baseDefinition = {
  name: "lazada",
  version: "0.1.0",
  description: "Lazada seller via the Lazada Open Platform (signed, regional): products, orders and order items; price, stock and fulfilment node only",
  tokenEnv: "LAZADA_ACCESS_TOKEN",
  extraEnv: ["LAZADA_APP_KEY", "LAZADA_APP_SECRET", "LAZADA_REGION"],
  createClient: createLazadaClient,
  operations: [...readOperations, ...writeOperations, createApiRequestOperation({ apiName: "Lazada Open Platform", examplePath: "/finance/transaction/details/get" })],
};

export const pluginDefinition = limitToolApiPaths(baseDefinition);
