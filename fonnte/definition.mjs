/**
 * fonnte plugin definition: Fonnte, an Indonesian WhatsApp gateway (https://docs.fonnte.com/category/api/) that
 * sends through a WhatsApp number linked to a Fonnte "device". Built with the declarative REST layer
 * (docs/declarative-plugins.md). The device token goes in the Authorization header as is (no Bearer). Every
 * endpoint is a POST with form fields; errors are 200 bodies with `status: false` and a `reason` or `detail`.
 *
 * Agent policy: `send_message` needs FONNTE_TOOL_ALLOW_SEND=1 as a tool and the recipient in
 * FONNTE_TOOL_RECIPIENT_ALLOWLIST (E.164 numbers or prefixes; unset refuses tool sends). Group sends, deleting
 * messages, disconnecting the device and re-fetching the group list (Fonnte warns it can get the number banned) are
 * node only. Numbers must be E.164 with "+"; the plugin sends digits with countryCode=0 so Fonnte never rewrites a
 * leading 0 to +62.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { PluginError } from "./lib/shared/graphrt-plugin.mjs";
import { guardRecipients, normalizeE164, wrapOperations } from "./lib/recipient-policy.mjs";

export const SEND_OPT_IN_ENV = "FONNTE_TOOL_ALLOW_SEND";
export const RECIPIENT_ALLOWLIST_ENV = "FONNTE_TOOL_RECIPIENT_ALLOWLIST";
const RECIPIENT_POLICY = { optInEnv: SEND_OPT_IN_ENV, allowlistEnv: RECIPIENT_ALLOWLIST_ENV, entryKind: "phone" };
const GROUP_ID_PATTERN = /^\d[\d-]{4,40}@g\.us$/;
const MAX_VALIDATE_NUMBERS = 500;
// countryCode=0 turns off Fonnte's "replace a leading 0 with 62" rewrite; numbers are already international.
const NO_COUNTRY_REWRITE = { countryCode: "0" };
const ERROR_KINDS = { "token invalid": "auth_error", "invalid token": "auth_error", "insufficient quota": "permission_denied", "target invalid": "invalid_input", "input invalid": "invalid_input" };
const SEND_CHECK_HINT = "the Fonnte dashboard's message report (or your webhook) for the target before sending again";

const messageContent = {
  message: { in: "body", type: "string", description: "Text (up to 60000 characters); the caption when file_url is set" },
  file_url: { in: "body", type: "string", wireName: "url", description: "Public URL of an image, video, audio or document to send (paid packages only)" },
  filename: { in: "body", type: "string", description: "File name shown to the recipient (documents and audio)" },
  schedule: { in: "body", type: "integer", min: 0, description: "Unix timestamp (seconds) to send at" },
  typing: { in: "body", type: "boolean", description: "Show a typing indicator first" },
  connect_only: { in: "body", type: "boolean", wireName: "connectOnly", description: "true (Fonnte default): refuse when the device is disconnected; false: queue" },
  preview: { in: "body", type: "boolean", description: "Link preview (default true)" },
};
const sendOperation = (overrides) => ({
  method: "POST",
  path: "/send",
  bodyMode: "multipart",
  write: "unsafe",
  checkHint: SEND_CHECK_HINT,
  constants: { body: NO_COUNTRY_REWRITE },
  ...overrides,
});
const freePost = (name, title, description, path) => ({ name, title, description, method: "POST", path, write: "idempotent" });
const nodeOnlyPost = (name, title, description, path, params = {}) => ({ name, title, description, method: "POST", path, bodyMode: "multipart", write: "unsafe", nodeOnly: true, params });

const operations = [
  freePost("get_device", "Device profile", "The device's number, connection status (connect/disconnect), package, remaining quota and expiry", "/device"),
  {
    ...freePost("validate_numbers", "Validate numbers", "Check which numbers are registered on WhatsApp (needs a connected device)", "/validate"),
    bodyMode: "multipart",
    params: { numbers: { in: "body", type: "array", items: { type: "string" }, maxItems: MAX_VALIDATE_NUMBERS, required: true, wireName: "target", description: 'E.164 numbers with +, e.g. ["+6281234567890"]' } },
    constants: { body: NO_COUNTRY_REWRITE },
  },
  freePost("list_whatsapp_groups", "List groups", "WhatsApp groups of the device as last fetched (id ...@g.us and name)", "/get-whatsapp-group"),
  sendOperation({
    name: "send_message",
    title: "Send message",
    description: "Send a WhatsApp message (text, or a file with caption) to one number; returns message ids and process status",
    toolPolicy: `optIn:${SEND_OPT_IN_ENV}`,
    params: { target: { in: "body", type: "string", required: true, description: 'Recipient in E.164 with +, e.g. "+6281234567890"' }, ...messageContent },
  }),
  sendOperation({
    name: "send_group_message",
    title: "Send group message",
    description: "Send a WhatsApp message to a group the device is in (id from list_whatsapp_groups)",
    nodeOnly: true,
    params: { group_id: { in: "body", type: "string", required: true, wireName: "target", description: "Group id, e.g. 120363000000000000@g.us" }, ...messageContent },
  }),
  nodeOnlyPost("delete_message", "Delete message", "Delete a pending or scheduled message (not one that is processing)", "/delete-message", { message_id: { in: "body", type: "string", required: true, wireName: "id", description: "Message id from send_message" } }),
  nodeOnlyPost("fetch_whatsapp_groups", "Refresh groups", "Re-fetch the device's group list from WhatsApp (Fonnte: call rarely, abuse can get the number banned)", "/fetch-group"),
  nodeOnlyPost("disconnect_device", "Disconnect device", "Log the WhatsApp number out of Fonnte (re-linking needs a QR scan)", "/disconnect"),
];

const restDefinition = defineRestPlugin({
  name: "fonnte",
  version: "0.1.0",
  description: "Fonnte WhatsApp gateway (Indonesia): send messages and files, validate numbers, device status and groups; agent sends need an opt-in and an E.164 recipient allowlist",
  apiName: "Fonnte API",
  baseUrl: "https://api.fonnte.com",
  auth: { type: "header", header: "Authorization", env: "FONNTE_TOKEN" },
  extraEnv: [RECIPIENT_ALLOWLIST_ENV],
  errors: {
    // Failures carry `reason` (send, validate, device) or only `detail` (groups, disconnect).
    messagePath: ["detail", "reason"],
    codePath: "reason",
    okPath: "status",
    okValue: true,
    kindByCode: ERROR_KINDS,
  },
  // Every Fonnte endpoint is a POST, so a GET-only api_request would have nothing to call.
  apiRequest: false,
  operations,
});

const toFonnteNumber = (rawNumber, argumentName) => normalizeE164(rawNumber, argumentName).slice(1);

// Fonnte accepts an empty send and reports it later; refuse it before the request.
function assertHasContent(args) {
  if (!args.message && !args.file_url) throw new PluginError("Give `message` or `file_url` (or both)", { kind: "invalid_input" });
}

function prepareDirectMessage(args) {
  assertHasContent(args);
  const target = toFonnteNumber(args.target, "target");
  return { args: { ...args, target }, recipients: [`+${target}`] };
}

function prepareGroupMessage(args) {
  assertHasContent(args);
  if (!GROUP_ID_PATTERN.test(String(args.group_id))) throw new PluginError('`group_id` must be a WhatsApp group id like "120363000000000000@g.us"', { kind: "invalid_input" });
  return { args, recipients: [] };
}

// Fonnte takes a comma-separated target list.
const withNormalizedNumbers = (operation) => ({
  ...operation,
  run: async (context) => {
    const numbers = context.args.numbers.map((rawNumber, index) => toFonnteNumber(rawNumber, `numbers[${index}]`));
    return operation.run({ ...context, args: { ...context.args, numbers: numbers.join(",") } });
  },
});

/**
 * Some Fonnte responses spell the flag `Status` (its own docs show `"Status": false`); the declarative okPath only
 * sees `status`, so this wrapper turns a capitalised `Status: false` into the same error.
 *
 * @param operation - Operation (object)
 * @returns Operation that refuses `Status: false` results (object)
 */
function rejectCapitalisedStatusFalse(operation) {
  return {
    ...operation,
    run: async (context) => {
      const result = await operation.run(context);
      const body = result?.data;
      if (!body || typeof body !== "object" || body.Status !== false) return result;
      const reason = [body.detail, body.reason].find((candidate) => typeof candidate === "string" && candidate !== "") ?? "Fonnte reported Status: false";
      throw new PluginError(`API error: ${reason}`, { kind: ERROR_KINDS[body.reason] ?? ERROR_KINDS[body.detail] ?? "api_error" });
    },
  };
}

const guardedDefinition = wrapOperations(restDefinition, {
  send_message: (operation) => guardRecipients(operation, prepareDirectMessage, RECIPIENT_POLICY),
  send_group_message: (operation) => guardRecipients(operation, prepareGroupMessage, RECIPIENT_POLICY),
  validate_numbers: withNormalizedNumbers,
});

export const pluginDefinition = { ...guardedDefinition, operations: guardedDefinition.operations.map(rejectCapitalisedStatusFalse) };
