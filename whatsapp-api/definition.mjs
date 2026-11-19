/**
 * whatsapp-api plugin definition: a business number through the official
 * WhatsApp Business Cloud API (Graph API). Incoming messages arrive only by
 * webhook, so they are out of scope (see README).
 */
import { createWhatsAppClient } from "./lib/client.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { accountOperations } from "./operations/account.mjs";
import { mediaOperations } from "./operations/media.mjs";
import { messagingOperations } from "./operations/messaging.mjs";
import { templateOperations } from "./operations/templates.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{resolveHostAddresses}`: `async (hostname) => string[]` used to refuse internal download hosts (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  return {
    name: "whatsapp-api",
    version: "0.2.0",
    description: "WhatsApp Business Cloud API: send messages and templates, manage media, templates and the business profile",
    tokenEnv: "WHATSAPP_ACCESS_TOKEN",
    extraEnv: ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_GRAPH_VERSION"],
    // upload_media may download and upload up to 100 MB.
    limits: { timeout_ms: 300000 },
    createClient: (clientOptions) => createWhatsAppClient({ ...clientOptions, resolveHostAddresses: dependencies.resolveHostAddresses }),
    operations: [
      ...messagingOperations,
      ...mediaOperations,
      ...templateOperations,
      ...accountOperations,
      createApiRequestOperation({ apiName: "WhatsApp Cloud API (Graph)", examplePath: "/{phone-number-id}" }),
    ],
  };
}

export const pluginDefinition = createPluginDefinition();
