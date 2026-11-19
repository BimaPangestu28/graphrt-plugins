/**
 * whatsapp-api plugin definition: a business number through the official
 * WhatsApp Business Cloud API (Graph API). Incoming messages arrive only by
 * webhook, so they are out of scope (see README).
 *
 * Agent policy (README "Agent policy"): sends from agent tools need WHATSAPP_TOOL_ALLOW_SEND=1 and the recipient
 * in WHATSAPP_TOOL_RECIPIENT_ALLOWLIST; deletes are node only; mark_as_read and reads are free tools.
 */
import { createWhatsAppClient } from "./lib/client.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { accountOperations } from "./operations/account.mjs";
import { mediaOperations } from "./operations/media.mjs";
import { messagingOperations, RECIPIENT_ALLOWLIST_ENV, SEND_OPERATION_NAMES, SEND_OPT_IN_ENV } from "./operations/messaging.mjs";
import { applyAgentPolicy, makeNodeOnly, requireToolOptIn, wrapEach } from "./lib/agent-tool-policy.mjs";
import { templateOperations } from "./operations/templates.mjs";
import { createSendRateLimiter, SEND_RATE_LIMIT_VARIABLE } from "./lib/send-rate-limiter.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - Overrides for tests (object, optional)
 * @param dependencies.resolveHostAddresses - `async (hostname) => string[]` used to refuse internal download hosts (function)
 * @param dependencies.now - Clock in milliseconds for the agent send limiter (function, default Date.now)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  // One limiter per plugin process, shared by every call (see lib/send-rate-limiter.mjs).
  const sendRateLimiter = createSendRateLimiter(dependencies.now ?? Date.now);
  return {
    name: "whatsapp-api",
    version: "0.4.0",
    description: "WhatsApp Business Cloud API: send messages and templates, manage media, templates and the business profile",
    tokenEnv: "WHATSAPP_ACCESS_TOKEN",
    extraEnv: ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_GRAPH_VERSION", SEND_RATE_LIMIT_VARIABLE, SEND_OPT_IN_ENV, RECIPIENT_ALLOWLIST_ENV],
    // upload_media may download and upload up to 100 MB.
    limits: { timeout_ms: 300000 },
    createClient: (clientOptions) => ({
      ...createWhatsAppClient({ ...clientOptions, resolveHostAddresses: dependencies.resolveHostAddresses }),
      sendRateLimiter,
    }),
    operations: applyAgentPolicy(
      [
        ...messagingOperations,
        ...mediaOperations,
        ...templateOperations,
        ...accountOperations,
        createApiRequestOperation({ apiName: "WhatsApp Cloud API (Graph)", examplePath: "/{phone-number-id}" }),
      ],
      AGENT_POLICY,
    ),
  };
}

const requireSendOptIn = requireToolOptIn(SEND_OPT_IN_ENV, `the recipient is in ${RECIPIENT_ALLOWLIST_ENV}`);

const AGENT_POLICY = {
  ...wrapEach(SEND_OPERATION_NAMES, requireSendOptIn),
  ...wrapEach(["delete_media", "delete_template"], makeNodeOnly),
};

export const pluginDefinition = createPluginDefinition();
