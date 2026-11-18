/**
 * Webhook routing: setWebhook, deleteWebhook, getWebhookInfo.
 *
 * All three are node-only: setting or deleting a webhook changes where the bot's updates go (and
 * get_updates stops working while one is set), so an LLM must not be able to do it.
 * The webhook secret token is a credential, so it comes only from TELEGRAM_WEBHOOK_SECRET.
 */
import { ALLOWED_UPDATES_PROPERTY, rejectInput } from "../lib/arguments.mjs";
import { createBotMethodRunner } from "../lib/client.mjs";

const SECRET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

function readWebhookSecret(environment) {
  const webhookSecret = environment?.TELEGRAM_WEBHOOK_SECRET;
  if (!webhookSecret) return undefined;
  if (!SECRET_TOKEN_PATTERN.test(webhookSecret)) rejectInput("TELEGRAM_WEBHOOK_SECRET must be 1-256 characters of A-Z, a-z, 0-9, _ or -");
  return webhookSecret;
}

function buildSetWebhookParams(args, environment) {
  if (!/^https:\/\/[^\s/]+/i.test(args.url)) rejectInput("`url` must be an https URL (ports 443, 80, 88 or 8443)");
  return {
    url: args.url,
    max_connections: args.max_connections,
    allowed_updates: args.allowed_updates,
    drop_pending_updates: args.drop_pending_updates,
    ip_address: args.ip_address,
    secret_token: readWebhookSecret(environment),
  };
}

export const webhookOperations = [
  {
    name: "set_webhook",
    title: "Set Telegram webhook",
    description:
      "Send the bot's updates to an https URL instead of get_updates. Sends TELEGRAM_WEBHOOK_SECRET (if set) as the X-Telegram-Bot-Api-Secret-Token header value. Node only.",
    nodeOnly: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "https URL that receives updates (ports 443, 80, 88 or 8443)" },
        max_connections: { type: "integer", minimum: 1, maximum: 100, description: "Maximum simultaneous connections (default 40)" },
        allowed_updates: ALLOWED_UPDATES_PROPERTY,
        drop_pending_updates: { type: "boolean", description: "Drop updates that are waiting" },
        ip_address: { type: "string", description: "Fixed IP address to send to instead of resolving the host" },
      },
      required: ["url"],
    },
    run: createBotMethodRunner("setWebhook", buildSetWebhookParams),
  },
  {
    name: "delete_webhook",
    title: "Delete Telegram webhook",
    description: "Remove the webhook so get_updates works again. Node only.",
    nodeOnly: true,
    parameters: { type: "object", properties: { drop_pending_updates: { type: "boolean", description: "Drop updates that are waiting" } } },
    run: createBotMethodRunner("deleteWebhook", (args) => ({ drop_pending_updates: args.drop_pending_updates })),
  },
  {
    name: "get_webhook_info",
    title: "Get Telegram webhook info",
    description: "Return the webhook URL (empty when using get_updates), pending update count and the last delivery error. Node only.",
    nodeOnly: true,
    parameters: { type: "object", properties: {} },
    run: createBotMethodRunner("getWebhookInfo", () => ({}), { read: true }),
  },
];
