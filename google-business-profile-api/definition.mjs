/**
 * google-business-profile-api plugin definition: accounts, locations, reviews,
 * posts and performance metrics of Google Business Profile listings.
 *
 * Operations receive `client = {account_management, business_information, my_business_v4, performance}`,
 * one shared-library client per Google host (see lib/client.mjs).
 */
import { BUSINESS_PROFILE_BASE_URLS, createBusinessProfileClients } from "./lib/client.mjs";
import { GOOGLE_AUTH_ENV, resolveGoogleCredentials } from "./lib/google-auth.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { accountLocationOperations } from "./operations/accounts-locations.mjs";
import { localPostOperations } from "./operations/local-posts.mjs";
import { performanceOperations } from "./operations/performance.mjs";
import { reviewOperations } from "./operations/reviews.mjs";

const HOST_SELECTOR_PROPERTY = {
  host: {
    type: "string",
    enum: Object.keys(BUSINESS_PROFILE_BASE_URLS),
    default: "my_business_v4",
    description: Object.entries(BUSINESS_PROFILE_BASE_URLS)
      .map(([hostKey, baseUrl]) => `${hostKey} = ${baseUrl.replace("https://", "")}`)
      .join("; "),
  },
};

export const pluginDefinition = {
  name: "google-business-profile-api",
  version: "0.1.0",
  description: "Google Business Profile accounts, locations, reviews, posts and performance metrics via the official Business Profile APIs",
  tokenEnv: "GOOGLE_ACCESS_TOKEN",
  extraEnv: GOOGLE_AUTH_ENV,
  resolveAccessToken: resolveGoogleCredentials,
  createClient: createBusinessProfileClients,
  operations: [
    ...accountLocationOperations,
    ...reviewOperations,
    ...localPostOperations,
    ...performanceOperations,
    createApiRequestOperation({
      apiName: "Google Business Profile API",
      examplePath: "/accounts/{account_id}/locations/{location_id}/media",
      extraProperties: HOST_SELECTOR_PROPERTY,
      selectClient: (client, args) => client[args.host],
    }),
  ],
};
