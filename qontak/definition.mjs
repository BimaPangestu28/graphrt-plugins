/**
 * qontak plugin definition: Mekari Qontak, an Indonesian CRM and omnichannel (WhatsApp) platform. Built with the
 * declarative REST layer (docs/declarative-plugins.md) from Qontak's official OpenAPI spec for the Mekari gateway
 * (github.com/qontak-dev/docs, Qontak-CRM-OpenAPI-MAG.json) and Mekari's qontak-api-js SDK.
 *
 * Auth (lib/qontak-auth.mjs): Mekari API HMAC on api.mekari.com (recommended), or bearer tokens on the older
 * service-chat.qontak.com / app.qontak.com hosts. Chat responses are {status, data, meta}; CRM responses are
 * {meta, response}.
 *
 * Agent policy:
 * - send_whatsapp_template (a paid WhatsApp template message to any number) needs QONTAK_TOOL_ALLOW_SEND=1 and
 *   the recipient in QONTAK_TOOL_RECIPIENT_ALLOWLIST (exact E.164 numbers; lib/recipient-policy.mjs, copied
 *   unchanged from twilio). Nodes are not limited.
 * - CRM creates and updates need QONTAK_TOOL_ALLOW_CRM_WRITES=1; CRM deletes are node only.
 * - list_integrations strips token/secret/webhook fields from tool results; api_request as a tool may only read
 *   TOOL_READ_PATH_PREFIXES (not /integrations).
 * Bulk broadcasts (POST /broadcasts/whatsapp) are not implemented: their request body is not in Qontak's docs.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardRecipients, normalizeE164 } from "./lib/recipient-policy.mjs";
import { restrictApiRequestToReadPaths } from "./lib/api-request-allowlist.mjs";
import { baseUrlFor, createQontakAuth, QONTAK_AUTH_ENV, resolveQontakNodeToken } from "./lib/qontak-auth.mjs";
import { stripSecretFieldsForTools } from "./lib/secret-fields.mjs";
import { crmOperations, CRM_WRITES_OPT_IN_ENV } from "./lib/crm-operations.mjs";

export const SEND_OPT_IN_ENV = "QONTAK_TOOL_ALLOW_SEND";
export const RECIPIENT_ALLOWLIST_ENV = "QONTAK_TOOL_RECIPIENT_ALLOWLIST";
export { CRM_WRITES_OPT_IN_ENV };
export const TOOL_READ_PATH_PREFIXES = ["/templates", "/rooms", "/broadcasts"];
const RECIPIENT_POLICY = { optInEnv: SEND_OPT_IN_ENV, allowlistEnv: RECIPIENT_ALLOWLIST_ENV, entryKind: "phone" };
const UUID = (description) => ({ in: "path", type: "string", required: true, minLength: 1, description });
const pageWindow = {
  offset: { in: "query", type: "integer", min: 0, description: "Page offset as Qontak counts it (see meta.pagination)" },
  limit: { in: "query", type: "integer", min: 1, max: 100, description: "Items per page" },
};

const templateOperations = [
  {
    name: "list_whatsapp_templates",
    title: "List WhatsApp templates",
    description: "Approved and pending WhatsApp message templates (id, name, language, category, status, body)",
    path: "/templates/whatsapp",
    params: { status: { in: "query", type: "string", description: "e.g. APPROVED" }, query: { in: "query", type: "string", description: "Search by name" }, ...pageWindow },
    response: { dataPath: "data" },
  },
  { name: "get_whatsapp_template", title: "Get WhatsApp template", description: "One message template with its components", path: "/templates/{template_id}/whatsapp", params: { template_id: UUID("Template id") }, response: { dataPath: "data" } },
  {
    name: "list_integrations",
    title: "List channel integrations",
    description: "Connected channels (WhatsApp numbers and others); channel_integration_id for sends",
    path: "/integrations",
    params: { target_channel: { in: "query", type: "string", description: "Channel, e.g. wa or wa_cloud" } },
    response: { dataPath: "data" },
  },
];

const roomOperations = [
  {
    name: "list_rooms",
    title: "List rooms",
    description: "Conversation rooms (one per contact and channel) with their last message, status and agents",
    path: "/rooms",
    params: {
      query: { in: "query", type: "string", description: "Search by name or number" },
      status: { in: "query", type: "string", description: "e.g. unassigned, assigned, resolved" },
      start_date: { in: "query", type: "string" },
      end_date: { in: "query", type: "string" },
      ...pageWindow,
    },
    response: { dataPath: "data" },
  },
  { name: "get_room", title: "Get room", description: "One conversation room", path: "/rooms/{room_id}", params: { room_id: UUID("Room id") }, response: { dataPath: "data" } },
  { name: "list_room_histories", title: "Room history", description: "History entries of a room (assignments, resolutions, sessions)", path: "/rooms/{room_id}/histories", params: { room_id: UUID("Room id") }, response: { dataPath: "data" } },
];

const broadcastOperations = [
  {
    name: "send_whatsapp_template",
    title: "Send WhatsApp template",
    description: "Send an approved WhatsApp template message to one number (a direct broadcast; billed per WhatsApp conversation)",
    method: "POST",
    path: "/broadcasts/whatsapp/direct",
    write: "unsafe",
    toolPolicy: `optIn:${SEND_OPT_IN_ENV}`,
    checkHint: "get_whatsapp_broadcast_log for the returned broadcast id, or list_whatsapp_broadcasts, before sending again",
    params: {
      to_number: { in: "body", type: "string", required: true, description: 'Recipient in E.164 with +, e.g. "+6281234567890"' },
      to_name: { in: "body", type: "string", required: true, minLength: 1, description: "Recipient name (the contact Qontak creates or updates)" },
      message_template_id: { in: "body", type: "string", required: true, minLength: 1, description: "From list_whatsapp_templates" },
      channel_integration_id: { in: "body", type: "string", required: true, minLength: 1, description: "From list_integrations" },
      language_code: { in: "body", type: "string", default: "id", wireName: "language.code", description: "Template language, e.g. id or en" },
      parameters: {
        in: "body",
        type: "object",
        description: 'Template variables, e.g. {"body": [{"key": "1", "value_text": "Budi", "value": "name"}], "header": {"format": "IMAGE", "params": [{"key": "url", "value": "https://..."}]}, "buttons": [{"index": "0", "type": "url", "value": "abc"}]}',
      },
    },
    response: { dataPath: "data" },
  },
  {
    name: "list_whatsapp_broadcasts",
    title: "List WhatsApp broadcasts",
    description: "Sent broadcasts (direct and bulk) with status counts",
    path: "/broadcasts/whatsapp",
    params: { start_date: { in: "query", type: "string" }, end_date: { in: "query", type: "string" }, category: { in: "query", type: "string" }, ...pageWindow },
    response: { dataPath: "data" },
  },
  { name: "get_whatsapp_broadcast", title: "Get WhatsApp broadcast", description: "One broadcast with template and status counts", path: "/broadcasts/{broadcast_id}/whatsapp", params: { broadcast_id: UUID("Broadcast id") }, response: { dataPath: "data" } },
  {
    name: "get_whatsapp_broadcast_log",
    title: "WhatsApp broadcast log",
    description: "Per-recipient delivery status of a broadcast (sent, delivered, read, failed with the WhatsApp error)",
    path: "/broadcasts/{broadcast_id}/whatsapp/log",
    params: { broadcast_id: UUID("Broadcast id"), ...pageWindow },
    response: { dataPath: "data" },
  },
];

export const restDefinition = defineRestPlugin({
  name: "qontak",
  version: "0.1.0",
  description: "Mekari Qontak: WhatsApp template sends (agent opt-in + E.164 allowlist), templates, channels, rooms and broadcast logs; CRM contacts, companies, deals, tasks, notes and pipelines (agent writes opt-in, deletes node only); Mekari HMAC or bearer tokens",
  apiName: "Qontak Chat API",
  baseUrl: baseUrlFor("chat"),
  auth: createQontakAuth(),
  extraEnv: [...QONTAK_AUTH_ENV, RECIPIENT_ALLOWLIST_ENV],
  errors: {
    // Chat: {"message": "..."} or {"status": "error", "error": {"code", "messages": [...]}}; CRM: {"meta": {developer_message, message}}.
    messagePath: ["error.messages.0", "meta.developer_message", "message", "meta.message"],
  },
  apiRequest: { examplePath: "/templates/whatsapp" },
  operations: [...templateOperations, ...roomOperations, ...broadcastOperations, ...crmOperations(baseUrlFor("crm"))],
});

function prepareTemplateSend(args) {
  const recipient = normalizeE164(args.to_number, "to_number");
  // Qontak takes the number as digits with the country code and no "+".
  return { args: { ...args, to_number: recipient.slice(1) }, recipients: [recipient] };
}

/**
 * Applies the plugin's wrappers: recipient checks on the send, secret stripping on integrations and (unless turned
 * off for the contract suite, whose api_request probe uses an arbitrary path) the api_request tool path allowlist.
 *
 * @param definition - Definition from defineRestPlugin (object)
 * @param options - `{guardApiRequestPaths}` (object)
 * @returns Wrapped definition with the Qontak credential resolver (object)
 */
export function wrapQontakDefinition(definition, { guardApiRequestPaths = true } = {}) {
  const wrappers = {
    send_whatsapp_template: (operation) => guardRecipients(operation, prepareTemplateSend, RECIPIENT_POLICY),
    list_integrations: stripSecretFieldsForTools,
    api_request: (operation) => (guardApiRequestPaths ? restrictApiRequestToReadPaths(operation, TOOL_READ_PATH_PREFIXES) : operation),
  };
  const operations = definition.operations.map((operation) => (wrappers[operation.name] ? wrappers[operation.name](operation) : operation));
  return { ...definition, operations, resolveAccessToken: resolveQontakNodeToken };
}

export const pluginDefinition = wrapQontakDefinition(restDefinition);
