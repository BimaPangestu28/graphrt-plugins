/**
 * Simple mail fields for SendGrid's `POST /v3/mail/send`. The declarative `send_mail` operation sends SendGrid's
 * body (personalizations, from, content, ...); this wrapper builds it from to/cc/bcc/subject/text/html or a dynamic
 * template, validates every address, and checks the recipients (and the Reply-To address) of tool sends against
 * the allowlist (lib/recipient-policy.mjs).
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { assertRecipientsAllowed, normalizeAddresses } from "./recipient-policy.mjs";

export const SEND_OPT_IN_ENV = "SENDGRID_TOOL_ALLOW_SEND";
export const RECIPIENT_ALLOWLIST_ENV = "SENDGRID_TOOL_RECIPIENT_ALLOWLIST";
// SendGrid allows 1000 cc/bcc addresses per message; the same cap is applied to `to`.
const MAX_RECIPIENTS_PER_FIELD = 1000;
const addressList = (description) => ({ type: "array", items: { type: "string" }, maxItems: MAX_RECIPIENTS_PER_FIELD, description });

export const COMPOSE_FIELDS = {
  from: { type: "string", description: "Sender address; must be a verified Sender Identity or on an authenticated domain" },
  from_name: { type: "string", description: "Sender display name" },
  to: addressList('Recipient addresses, e.g. ["ada@example.com"] (plain addresses, no display names)'),
  cc: addressList("Cc addresses"),
  bcc: addressList("Bcc addresses"),
  reply_to: { type: "string", description: "Reply-To address" },
  subject: { type: "string", description: "Subject (required unless template_id is a dynamic template with its own subject)" },
  text: { type: "string", description: "Plain-text body" },
  html: { type: "string", description: "HTML body" },
  template_id: { type: "string", description: "Template id; d-... for dynamic templates (then subject/text/html come from the template)" },
  dynamic_template_data: { type: "object", description: "Handlebars data for a dynamic template, e.g. {first_name: \"Ada\"}" },
  categories: { type: "array", items: { type: "string" }, maxItems: 10, description: "Up to 10 categories for stats" },
  send_at: { type: "integer", description: "Unix time to send at (at most 72 hours ahead)" },
  asm_group_id: { type: "integer", description: "Unsubscribe group id (list_unsubscribe_groups) for the unsubscribe link" },
  sandbox_mode: { type: "boolean", description: "Validate the request without sending (nothing is delivered)" },
};

const failInput = (message) => {
  throw new PluginError(message, { kind: "invalid_input" });
};

function readAddresses(value, fieldName) {
  if (value === undefined || value === null || value === "") return [];
  return normalizeAddresses(Array.isArray(value) ? value : [value], fieldName);
}

function readOptionalInteger(value, fieldName) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) failInput(`\`${fieldName}\` must be a non-negative integer`);
  return number;
}

function buildPersonalization(args) {
  const toAddresses = readAddresses(args.to, "to");
  if (toAddresses.length === 0) failInput("`to` needs at least one recipient address");
  const ccAddresses = readAddresses(args.cc, "cc");
  const bccAddresses = readAddresses(args.bcc, "bcc");
  const toEmailObjects = (addresses) => addresses.map((email) => ({ email }));
  const personalization = { to: toEmailObjects(toAddresses) };
  if (ccAddresses.length > 0) personalization.cc = toEmailObjects(ccAddresses);
  if (bccAddresses.length > 0) personalization.bcc = toEmailObjects(bccAddresses);
  if (args.dynamic_template_data !== undefined) {
    if (!args.dynamic_template_data || typeof args.dynamic_template_data !== "object" || Array.isArray(args.dynamic_template_data)) failInput("`dynamic_template_data` must be an object");
    personalization.dynamic_template_data = args.dynamic_template_data;
  }
  return { personalization, recipients: [...toAddresses, ...ccAddresses, ...bccAddresses] };
}

function buildContent(args) {
  const content = [];
  if (typeof args.text === "string" && args.text !== "") content.push({ type: "text/plain", value: args.text });
  if (typeof args.html === "string" && args.html !== "") content.push({ type: "text/html", value: args.html });
  return content;
}

function addOptionalFields(body, args) {
  if (args.reply_to) body.reply_to = { email: readAddresses(args.reply_to, "reply_to")[0] };
  if (args.subject) body.subject = String(args.subject);
  if (args.template_id) body.template_id = String(args.template_id);
  if (args.categories?.length) body.categories = args.categories.map(String);
  const sendAt = readOptionalInteger(args.send_at, "send_at");
  if (sendAt !== undefined) body.send_at = sendAt;
  const asmGroupId = readOptionalInteger(args.asm_group_id, "asm_group_id");
  if (asmGroupId !== undefined) body.asm = { group_id: asmGroupId };
  if (args.sandbox_mode === true || args.sandbox_mode === "true") body.mail_settings = { sandbox_mode: { enable: true } };
}

/**
 * Builds the mail/send body from simple fields.
 *
 * @param args - COMPOSE_FIELDS values (object)
 * @returns `{body, recipients}`: the JSON body and every to/cc/bcc and reply_to address (object)
 * @throws PluginError kind `invalid_input` - Bad addresses, no recipient, no content and no template, no subject
 *
 * @example
 * buildMailSendBody({ from: "news@example.com", to: ["ada@example.com"], subject: "Hi", text: "Hello" }).body;
 * // { personalizations: [{ to: [{ email: "ada@example.com" }] }], from: { email: "news@example.com" }, subject: "Hi", content: [...] }
 */
export function buildMailSendBody(args) {
  const { personalization, recipients } = buildPersonalization(args);
  const [fromAddress] = readAddresses(args.from, "from");
  if (!fromAddress) failInput("`from` is required");
  const content = buildContent(args);
  if (!args.template_id && content.length === 0) failInput("Give `text`, `html` or a `template_id`");
  if (!args.template_id && !args.subject) failInput("`subject` is required without a template_id");
  const body = { personalizations: [personalization], from: args.from_name ? { email: fromAddress, name: String(args.from_name) } : { email: fromAddress } };
  addOptionalFields(body, args);
  if (content.length > 0) body.content = content;
  const replyToAddresses = body.reply_to ? [body.reply_to.email] : [];
  return { body: reorderBody(body), recipients: [...recipients, ...replyToAddresses] };
}

// Stable key order (as in SendGrid's docs) keeps request bodies easy to compare in logs and tests.
function reorderBody(body) {
  const keyOrder = ["personalizations", "from", "reply_to", "subject", "content", "template_id", "categories", "send_at", "asm", "mail_settings"];
  return Object.fromEntries(keyOrder.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
}

/**
 * Wraps the declarative `send_mail` (body params personalizations/from/reply_to/subject/content/...).
 *
 * @param operation - Generated send_mail operation (object)
 * @returns Operation taking simple fields (object)
 */
export function wrapSendMail(operation) {
  return {
    ...operation,
    parameters: { type: "object", properties: COMPOSE_FIELDS, required: ["from", "to"] },
    run: (context) => {
      const { body, recipients } = buildMailSendBody(context.args ?? {});
      assertRecipientsAllowed(context, recipients, RECIPIENT_ALLOWLIST_ENV);
      return operation.run({ ...context, args: body });
    },
  };
}
