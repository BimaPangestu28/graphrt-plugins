/**
 * vonage plugin definition: SMS and WhatsApp through the Vonage Messages API v1
 * (https://developer.vonage.com/en/api/messages), Number Insight (https://developer.vonage.com/en/api/number-insight)
 * and the account balance (https://developer.vonage.com/en/api/account). Built with the declarative REST layer
 * (docs/declarative-plugins.md). Basic auth with the API key and secret, which all three APIs accept.
 *
 * Agent policy: every send costs money and reaches a person. The send operations need VONAGE_TOOL_ALLOW_SEND=1 as
 * tools and every recipient in VONAGE_TOOL_RECIPIENT_ALLOWLIST (exact E.164 numbers, or prefixes ending in * with
 * at least 4 digits; unset refuses tool sends). Number Insight is "unsafe" (never retried); its paid standard and
 * advanced levels need VONAGE_TOOL_ALLOW_INSIGHT=1 as tools. No operation takes a webhook_url: Vonage would post
 * message status to it. Marking WhatsApp messages read (PATCH /v1/messages) needs JWT auth and is not offered.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { PluginError } from "./lib/shared/graphrt-plugin.mjs";
import { guardRecipients, normalizeE164, wrapOperations } from "./lib/recipient-policy.mjs";

export const SEND_OPT_IN_ENV = "VONAGE_TOOL_ALLOW_SEND";
export const RECIPIENT_ALLOWLIST_ENV = "VONAGE_TOOL_RECIPIENT_ALLOWLIST";
export const INSIGHT_OPT_IN_ENV = "VONAGE_TOOL_ALLOW_INSIGHT";
const PAID_INSIGHT_LEVELS = new Set(["standard", "advanced"]);
// The recipient and sender come from `to`/`from`, so `custom` may not carry its own.
const FORBIDDEN_CUSTOM_KEYS = ["to", "recipient_type", "from"];
const REGION_ENV = "VONAGE_MESSAGES_REGION";
const RECIPIENT_POLICY = { optInEnv: SEND_OPT_IN_ENV, allowlistEnv: RECIPIENT_ALLOWLIST_ENV, entryKind: "phone" };
const MESSAGES_HOSTS = { "": "api.nexmo.com", eu: "api-eu.nexmo.com", us: "api-us.nexmo.com", ap: "api-ap.nexmo.com" };
const SEND_CHECK_HINT = "the Vonage dashboard's Messages logs (or your status webhook) for the client_ref or recipient before sending again";

const recipient = { in: "body", type: "string", required: true, description: 'Recipient in E.164 with +, e.g. "+6281234567890"' };
const clientRef = { in: "body", type: "string", wireName: "client_ref", description: "Your reference (up to 100 characters), echoed in status webhooks" };
const whatsappSender = { in: "body", type: "string", required: true, description: "Your WhatsApp Business number, E.164 with +" };
const sendOperation = (name, title, description, { params, constants }) => ({
  name,
  title,
  description,
  method: "POST",
  path: "/v1/messages",
  write: "unsafe",
  toolPolicy: `optIn:${SEND_OPT_IN_ENV}`,
  checkHint: SEND_CHECK_HINT,
  params: { to: recipient, ...params, client_ref: clientRef },
  constants: { body: constants },
});

const messageOperations = [
  sendOperation("send_sms", "Send SMS", "Send an SMS (paid per segment; Vonage answers 202 with message_uuid)", {
    params: {
      from: { in: "body", type: "string", required: true, description: "Sender: your Vonage number in E.164 or an alphanumeric sender id where allowed" },
      text: { in: "body", type: "string", required: true, minLength: 1, description: "Message text (up to 3200 characters)" },
      ttl_seconds: { in: "body", type: "integer", min: 20, max: 604800, wireName: "ttl", description: "Give up delivery after this many seconds" },
      encoding_type: { in: "body", type: "string", enum: ["text", "unicode", "auto"], wireName: "sms.encoding_type", description: "Default auto" },
    },
    constants: { channel: "sms", message_type: "text" },
  }),
  sendOperation("send_whatsapp_text", "Send WhatsApp text", "Send a WhatsApp text (only inside the 24-hour customer care window; paid)", {
    params: { from: whatsappSender, text: { in: "body", type: "string", required: true, minLength: 1, description: "Message text (up to 4096 characters)" } },
    constants: { channel: "whatsapp", message_type: "text" },
  }),
  sendOperation("send_whatsapp_image", "Send WhatsApp image", "Send a WhatsApp image from a public URL (inside the 24-hour window; paid)", {
    params: {
      from: whatsappSender,
      image_url: { in: "body", type: "string", required: true, wireName: "image.url", description: "Public https URL of a JPG or PNG" },
      caption: { in: "body", type: "string", wireName: "image.caption" },
    },
    constants: { channel: "whatsapp", message_type: "image" },
  }),
  sendOperation("send_whatsapp_template", "Send WhatsApp template", "Send an approved WhatsApp message template, also outside the 24-hour window (paid per template category)", {
    params: {
      from: whatsappSender,
      template_name: { in: "body", type: "string", required: true, wireName: "template.name", description: 'Template name, e.g. "namespace:order_update" or "order_update"' },
      template_parameters: { in: "body", type: "array", items: { type: "string" }, maxItems: 30, wireName: "template.parameters", description: "Values for {{1}}, {{2}}, ... in order" },
      locale: { in: "body", type: "string", default: "en", wireName: "whatsapp.locale", description: "Template language, e.g. en, en_GB, id" },
    },
    constants: { channel: "whatsapp", message_type: "template", "whatsapp.policy": "deterministic" },
  }),
  sendOperation("send_whatsapp_custom", "Send WhatsApp custom", "Send any WhatsApp Cloud API message object (media/interactive templates, buttons, lists) as `custom` (paid)", {
    params: { from: whatsappSender, custom: { in: "body", type: "object", required: true, description: 'WhatsApp message object, e.g. {"type": "template", "template": {...}}' } },
    constants: { channel: "whatsapp", message_type: "custom" },
  }),
];

const NUMBER_INSIGHT_BASE_URL = "https://api.nexmo.com";
const otherOperations = [
  {
    name: "number_insight",
    title: "Number Insight",
    description: `Number Insight v1: basic (format, country; free), standard (+ carrier, ported) or advanced (+ validity, reachability, roaming); standard and advanced are billed per request (as agent tools only when ${INSIGHT_OPT_IN_ENV}=1)`,
    baseUrl: NUMBER_INSIGHT_BASE_URL,
    path: "/ni/{level}/json",
    write: "unsafe",
    checkHint: "request_price/remaining_balance in a later response, or get_balance",
    params: {
      level: { in: "path", type: "string", required: true, enum: ["basic", "standard", "advanced"], description: "Insight level" },
      number: { in: "query", type: "string", required: true, description: "Number in international format (or national with country)" },
      country: { in: "query", type: "string", description: "ISO 3166-1 alpha-2 country for a national number, e.g. ID" },
      cnam: { in: "query", type: "boolean", description: "Caller name for US numbers (standard/advanced; extra charge)" },
    },
  },
  { name: "get_balance", title: "Account balance", description: "Account balance in EUR and whether auto-reload is on", baseUrl: "https://rest.nexmo.com", path: "/account/get-balance" },
];

/**
 * Picks the Messages API host from VONAGE_MESSAGES_REGION (unset: api.nexmo.com).
 *
 * @param environment - Environment variables (object)
 * @returns Base URL (string)
 * @throws Error - Unknown region (becomes invalid_input)
 */
function buildMessagesBaseUrl(environment) {
  const region = String(environment[REGION_ENV] ?? "").trim().toLowerCase();
  if (!Object.hasOwn(MESSAGES_HOSTS, region)) throw new Error(`${REGION_ENV} must be eu, us or ap (or unset for the default)`);
  return `https://${MESSAGES_HOSTS[region]}`;
}

const restDefinition = defineRestPlugin({
  name: "vonage",
  version: "0.1.0",
  description: "Vonage: send SMS and WhatsApp (text, image, templates, custom) through the Messages API, Number Insight and balance; agent sends need an opt-in and an E.164 recipient allowlist",
  apiName: "Vonage Messages API",
  baseUrl: buildMessagesBaseUrl,
  allowedHostSuffix: ".nexmo.com",
  auth: { type: "basic", userEnv: "VONAGE_API_KEY", passwordEnv: "VONAGE_API_SECRET" },
  extraEnv: [RECIPIENT_ALLOWLIST_ENV, REGION_ENV, INSIGHT_OPT_IN_ENV],
  // Messages errors are RFC 7807 {type, title, detail, instance}; Number Insight answers 200 with a non-zero
  // `status` and `status_message` (4 = bad credentials, 1 = throttled).
  errors: {
    messagePath: ["detail", "title", "status_message", "error_text"],
    codePath: "status",
    okPath: "status",
    okValue: 0,
    kindByCode: { 1: "rate_limited", 3: "invalid_input", 4: "auth_error", 9: "permission_denied" },
  },
  // Messages has no other GET resources worth exposing, and Number Insight GETs are paid.
  apiRequest: false,
  operations: [...otherOperations, ...messageOperations],
});

// Vonage wants numbers as E.164 digits without "+"; senders may also be alphanumeric ids (SMS).
const toVonageNumber = (rawNumber, argumentName) => normalizeE164(rawNumber, argumentName).slice(1);
const prepareSend = (isWhatsapp) => (args) => {
  const to = toVonageNumber(args.to, "to");
  const from = isWhatsapp || String(args.from).trim().startsWith("+") ? toVonageNumber(args.from, "from") : args.from;
  return { args: { ...args, to, from }, recipients: [`+${to}`] };
};
const guardSend = (isWhatsapp) => (operation) => guardRecipients(operation, prepareSend(isWhatsapp), RECIPIENT_POLICY);

const prepareCustomSend = (args) => {
  const smuggledKey = FORBIDDEN_CUSTOM_KEYS.find((keyName) => Object.hasOwn(args.custom ?? {}, keyName));
  if (smuggledKey) throw new PluginError(`\`custom\` may not contain \`${smuggledKey}\`: the recipient and sender come from \`to\` and \`from\``, { kind: "invalid_input" });
  return prepareSend(true)(args);
};

/**
 * Wraps number_insight: tool calls for the paid levels need VONAGE_TOOL_ALLOW_INSIGHT=1.
 *
 * @param operation - Generated number_insight operation (object)
 * @returns Operation with the level check (object)
 */
function guardPaidInsight(operation) {
  return {
    ...operation,
    run: async (context) => {
      const isRefused = context.source === "tool" && PAID_INSIGHT_LEVELS.has(context.args.level) && context.environment?.[INSIGHT_OPT_IN_ENV] !== "1";
      if (isRefused) throw new PluginError(`Number Insight \`${context.args.level}\` is billed per request and disabled for agent tools; set ${INSIGHT_OPT_IN_ENV}=1 to allow it, use level basic, or use a workflow node`, { kind: "permission_denied" });
      return operation.run(context);
    },
  };
}

export const pluginDefinition = wrapOperations(restDefinition, {
  send_sms: guardSend(false),
  send_whatsapp_text: guardSend(true),
  send_whatsapp_image: guardSend(true),
  send_whatsapp_template: guardSend(true),
  send_whatsapp_custom: (operation) => guardRecipients(operation, prepareCustomSend, RECIPIENT_POLICY),
  number_insight: guardPaidInsight,
});
