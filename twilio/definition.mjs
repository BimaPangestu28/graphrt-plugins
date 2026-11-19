/**
 * twilio plugin definition: Programmable Messaging (SMS, MMS and WhatsApp), voice call logs and outbound calls,
 * Lookup v2 and the account balance through the Twilio REST API (https://www.twilio.com/docs/usage/api). Built
 * with the declarative REST layer (docs/declarative-plugins.md). Basic auth with the Account SID and auth token;
 * the Account SID is also part of every 2010-04-01 path, so the base URL is built from it (validated).
 *
 * Agent policy: every send costs money and reaches a person. `send_sms` and `send_whatsapp` need
 * TWILIO_TOOL_ALLOW_SEND=1 as tools and every recipient in TWILIO_TOOL_RECIPIENT_ALLOWLIST (exact E.164 numbers,
 * or prefixes ending in * with at least 4 digits; unset refuses tool sends). Calls and deletes are node only. Paid
 * Lookup data packages are "unsafe" (never retried) and need TWILIO_TOOL_ALLOW_LOOKUP=1 as tools. No operation
 * takes a StatusCallback: Twilio would post message data to that URL.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardRecipients, normalizeE164, wrapOperations } from "./lib/recipient-policy.mjs";
import { withTwilioPaging } from "./lib/twilio-paging.mjs";

export const SEND_OPT_IN_ENV = "TWILIO_TOOL_ALLOW_SEND";
export const RECIPIENT_ALLOWLIST_ENV = "TWILIO_TOOL_RECIPIENT_ALLOWLIST";
export const LOOKUP_OPT_IN_ENV = "TWILIO_TOOL_ALLOW_LOOKUP";
const RECIPIENT_POLICY = { optInEnv: SEND_OPT_IN_ENV, allowlistEnv: RECIPIENT_ALLOWLIST_ENV, entryKind: "phone" };
const ACCOUNT_SID_PATTERN = /^AC[0-9a-fA-F]{32}$/;
const SEND_CHECK_HINT = "list_messages with the same `to` (and date_sent of today) and look for the body before sending again";

const pageParams = {
  page_size: { in: "query", type: "integer", min: 1, max: 1000, default: 50, wireName: "PageSize", description: "Items per page (max 1000)" },
  // Set from `cursor` by lib/twilio-paging.mjs and hidden from the schema.
  page: { in: "query", type: "integer", min: 0, wireName: "Page" },
  page_token: { in: "query", type: "string", wireName: "PageToken" },
};
const dateFilters = (prefix, wirePrefix, label) => ({
  [prefix]: { in: "query", type: "string", wireName: wirePrefix, description: `${label} on this day, YYYY-MM-DD (UTC)` },
  [`${prefix}_before`]: { in: "query", type: "string", wireName: `${wirePrefix}<`, description: `${label} before this day, YYYY-MM-DD` },
  [`${prefix}_after`]: { in: "query", type: "string", wireName: `${wirePrefix}>`, description: `${label} after this day, YYYY-MM-DD` },
});
const messageFields = {
  to: { in: "body", type: "string", required: true, wireName: "To", description: 'Recipient in E.164 format with +, e.g. "+6281234567890"' },
  body: { in: "body", type: "string", wireName: "Body", description: "Message text (up to 1600 characters)" },
  messaging_service_sid: { in: "body", type: "string", wireName: "MessagingServiceSid", description: "Send through a Messaging Service (MG...) instead of `from`" },
  media_urls: { in: "body", type: "array", items: { type: "string" }, maxItems: 10, wireName: "MediaUrl", description: "Public https URLs of media to attach (MMS / WhatsApp)" },
  content_sid: { in: "body", type: "string", wireName: "ContentSid", description: "Content template (HX...), e.g. an approved WhatsApp template" },
  content_variables: { in: "body", type: "string", wireName: "ContentVariables", description: 'Template variables as a JSON string, e.g. {"1":"Ada"}' },
  validity_period_seconds: { in: "body", type: "integer", min: 1, max: 36000, wireName: "ValidityPeriod", description: "Drop the message if not sent within this many seconds" },
};
const sendMessage = (name, title, description, fromDescription) => ({
  name,
  title,
  description,
  method: "POST",
  path: "/Messages.json",
  bodyMode: "form",
  formArrays: "repeat",
  write: "unsafe",
  toolPolicy: `optIn:${SEND_OPT_IN_ENV}`,
  checkHint: SEND_CHECK_HINT,
  params: { ...messageFields, from: { in: "body", type: "string", wireName: "From", description: fromDescription } },
});

const messageOperations = [
  sendMessage("send_sms", "Send SMS", "Send an SMS or MMS (paid per segment; Twilio answers with the queued message)", "Your Twilio number in E.164, a short code or an alphanumeric sender id (or use messaging_service_sid)"),
  sendMessage("send_whatsapp", "Send WhatsApp", "Send a WhatsApp message (free-form inside the 24-hour window, otherwise use content_sid with an approved template; paid)", 'Your WhatsApp-enabled Twilio number in E.164, e.g. "+14155238886" (or use messaging_service_sid)'),
  {
    name: "list_messages",
    title: "List messages",
    description: "Messages sent and received by the account, newest first",
    path: "/Messages.json",
    toolOutput: false,
    params: {
      to: { in: "query", type: "string", wireName: "To", description: "Only messages to this number (whatsapp:+... for WhatsApp)" },
      from: { in: "query", type: "string", wireName: "From", description: "Only messages from this number" },
      ...dateFilters("date_sent", "DateSent", "Sent"),
      ...pageParams,
    },
  },
  { name: "get_message", title: "Get message", description: "One message with its status, price and error code", path: "/Messages/{message_sid}.json", params: { message_sid: { in: "path", type: "string", required: true, description: "Message SID (SM... or MM...)" } } },
  {
    name: "delete_message",
    title: "Delete message",
    description: "Delete a message record from the account logs",
    method: "DELETE",
    path: "/Messages/{message_sid}.json",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_message with the SID (not_found means it was deleted)",
    params: { message_sid: { in: "path", type: "string", required: true, description: "Message SID" } },
  },
];

const callOperations = [
  {
    name: "list_calls",
    title: "List calls",
    description: "Voice calls of the account, newest first",
    path: "/Calls.json",
    toolOutput: false,
    params: {
      to: { in: "query", type: "string", wireName: "To", description: "Only calls to this number" },
      from: { in: "query", type: "string", wireName: "From", description: "Only calls from this number" },
      status: { in: "query", type: "string", wireName: "Status", enum: ["queued", "ringing", "in-progress", "canceled", "completed", "failed", "busy", "no-answer"] },
      ...dateFilters("start_time", "StartTime", "Started"),
      ...pageParams,
    },
  },
  { name: "get_call", title: "Get call", description: "One call with its status, duration and price", path: "/Calls/{call_sid}.json", params: { call_sid: { in: "path", type: "string", required: true, description: "Call SID (CA...)" } } },
  {
    name: "create_call",
    title: "Create call",
    description: "Place an outbound voice call that runs TwiML from `url`, inline `twiml` or an application (paid per minute)",
    method: "POST",
    path: "/Calls.json",
    bodyMode: "form",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_calls with the same `to` and look for the call before calling again",
    params: {
      to: { in: "body", type: "string", required: true, wireName: "To", description: "Number to call, E.164 with +" },
      from: { in: "body", type: "string", required: true, wireName: "From", description: "Your Twilio number, E.164" },
      twiml_url: { in: "body", type: "string", wireName: "Url", description: "URL Twilio fetches the call's TwiML from" },
      twiml: { in: "body", type: "string", wireName: "Twiml", description: 'Inline TwiML, e.g. "<Response><Say>Hello</Say></Response>"' },
      application_sid: { in: "body", type: "string", wireName: "ApplicationSid", description: "TwiML App (AP...) to run instead of url/twiml" },
      ring_timeout_seconds: { in: "body", type: "integer", min: 5, max: 600, wireName: "Timeout", description: "Seconds to let it ring (default 60)" },
      record: { in: "body", type: "boolean", wireName: "Record", description: "Record the call" },
    },
  },
];

const LOOKUP_BASE_URL = "https://lookups.twilio.com";
const PAID_LOOKUP_FIELDS = ["line_type_intelligence", "caller_name", "sim_swap", "call_forwarding", "line_status", "reassigned_number", "sms_pumping_risk", "phone_number_quality_score"];
const lookupNumber = { in: "path", type: "string", required: true, description: 'Number in E.164 (e.g. "+6281234567890") or national format with country_code' };
const lookupCountry = { in: "query", type: "string", wireName: "CountryCode", description: "ISO country for a national-format number, e.g. ID" };

const lookupAndAccountOperations = [
  {
    name: "lookup_phone_number",
    title: "Lookup number",
    description: "Free Lookup v2: validate and format a phone number (valid, E.164, national format, country)",
    baseUrl: LOOKUP_BASE_URL,
    path: "/v2/PhoneNumbers/{phone_number}",
    params: { phone_number: lookupNumber, country_code: lookupCountry },
  },
  {
    name: "lookup_phone_number_data",
    title: "Lookup number data",
    description: "Paid Lookup v2 data packages: line type, caller name, SIM swap, call forwarding, line status, reassigned number, SMS pumping risk (billed per package)",
    baseUrl: LOOKUP_BASE_URL,
    path: "/v2/PhoneNumbers/{phone_number}",
    write: "unsafe",
    toolPolicy: `optIn:${LOOKUP_OPT_IN_ENV}`,
    checkHint: "the Twilio Console usage records for Lookup",
    params: {
      phone_number: lookupNumber,
      fields: { in: "query", type: "array", items: { type: "string", enum: PAID_LOOKUP_FIELDS }, maxItems: PAID_LOOKUP_FIELDS.length, required: true, wireName: "Fields", description: "Data packages to buy" },
      country_code: lookupCountry,
    },
  },
  { name: "get_balance", title: "Account balance", description: "Current account balance and its currency", path: "/Balance.json" },
];

/**
 * Builds the 2010-04-01 base URL from the Account SID.
 *
 * @param environment - Environment variables (object)
 * @returns Base URL (string)
 * @throws Error - TWILIO_ACCOUNT_SID is not an AC... SID (becomes invalid_input)
 */
function buildAccountBaseUrl(environment) {
  const accountSid = String(environment.TWILIO_ACCOUNT_SID ?? "").trim();
  if (!ACCOUNT_SID_PATTERN.test(accountSid)) throw new Error("TWILIO_ACCOUNT_SID must be your Account SID: AC followed by 32 hex characters");
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`;
}

const restDefinition = defineRestPlugin({
  name: "twilio",
  version: "0.1.0",
  description: "Twilio: send SMS and WhatsApp, list and read messages and calls, place calls (node only), Lookup v2 and balance; agent sends need an opt-in and a recipient allowlist",
  apiName: "Twilio REST API (2010-04-01 account resources)",
  baseUrl: buildAccountBaseUrl,
  auth: { type: "basic", userEnv: "TWILIO_ACCOUNT_SID", passwordEnv: "TWILIO_AUTH_TOKEN" },
  extraEnv: [RECIPIENT_ALLOWLIST_ENV],
  // Errors are {code, message, more_info, status} (https://www.twilio.com/docs/usage/twilios-response).
  errors: {
    messagePath: "message",
    codePath: "code",
    kindByCode: { 20003: "auth_error", 20005: "auth_error", 20404: "not_found", 20429: "rate_limited", 21211: "invalid_input", 21610: "permission_denied" },
  },
  apiRequest: { examplePath: "/Recordings.json" },
  operations: [...lookupAndAccountOperations, ...messageOperations, ...callOperations],
});

// Twilio expects WhatsApp numbers as whatsapp:+E164 in To and From.
const prepareMessage = (channelPrefix) => (args) => {
  const to = normalizeE164(args.to, "to");
  const from = args.from === undefined || channelPrefix === "" ? args.from : `${channelPrefix}${normalizeE164(args.from, "from")}`;
  return { args: { ...args, to: `${channelPrefix}${to}`, ...(from === undefined ? {} : { from }) }, recipients: [to] };
};
const prepareCall = (args) => ({ args: { ...args, to: normalizeE164(args.to, "to") }, recipients: [] });

export const pluginDefinition = wrapOperations(restDefinition, {
  send_sms: (operation) => guardRecipients(operation, prepareMessage(""), RECIPIENT_POLICY),
  send_whatsapp: (operation) => guardRecipients(operation, prepareMessage("whatsapp:"), RECIPIENT_POLICY),
  create_call: (operation) => guardRecipients(operation, prepareCall, RECIPIENT_POLICY),
  list_messages: (operation) => withTwilioPaging(operation, "messages"),
  list_calls: (operation) => withTwilioPaging(operation, "calls"),
});
