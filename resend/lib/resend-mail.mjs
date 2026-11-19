/**
 * Checks for Resend's `POST /emails`: every address is validated, the sender may carry a display name
 * (`Acme <news@example.com>`) but no control characters, the body is text/html or a template (never both), and the
 * recipients (and Reply-To addresses) of tool sends are checked against the allowlist (lib/recipient-policy.mjs).
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { assertRecipientsAllowed, normalizeAddresses } from "./recipient-policy.mjs";

export const SEND_OPT_IN_ENV = "RESEND_TOOL_ALLOW_SEND";
export const RECIPIENT_ALLOWLIST_ENV = "RESEND_TOOL_RECIPIENT_ALLOWLIST";
const DISPLAY_NAME_SENDER_PATTERN = /^([^\x00-\x1f\x7f<>]{1,200})<([^<>]+)>$/;

const failInput = (message) => {
  throw new PluginError(message, { kind: "invalid_input" });
};

function readAddresses(value, fieldName) {
  if (value === undefined || value === null || value === "") return undefined;
  return normalizeAddresses(Array.isArray(value) ? value : [value], fieldName);
}

function readSender(from) {
  const sender = String(from ?? "").trim();
  if (sender === "") failInput("`from` is required, e.g. \"Acme <news@example.com>\"");
  const displayNameMatch = DISPLAY_NAME_SENDER_PATTERN.exec(sender);
  if (!displayNameMatch) return normalizeAddresses([sender], "from")[0];
  normalizeAddresses([displayNameMatch[2]], "from");
  return sender;
}

function checkBody(args) {
  const hasContent = Boolean(args.html) || Boolean(args.text);
  if (args.template_id && hasContent) failInput("Use either `template_id` or `html`/`text`, not both");
  if (!args.template_id && !hasContent) failInput("Give `html`, `text` or a `template_id`");
  if (!args.template_id && !args.subject) failInput("`subject` is required without a template_id");
}

/**
 * Validates and normalizes send_email arguments.
 *
 * @param args - send_email arguments (object)
 * @returns `{args, recipients}`: arguments with address lists as trimmed arrays, and every to/cc/bcc/reply_to address (object)
 * @throws PluginError kind `invalid_input` - Bad addresses or sender, no recipient, no body, body and template mixed
 *
 * @example
 * normalizeSendArgs({ from: "Acme <a@example.com>", to: "b@example.com", subject: "Hi", text: "x" }).args.to; // ["b@example.com"]
 */
export function normalizeSendArgs(args) {
  const normalizedArgs = { ...args, from: readSender(args.from) };
  for (const fieldName of ["to", "cc", "bcc", "reply_to"]) {
    const addresses = readAddresses(args[fieldName], fieldName);
    if (addresses === undefined) delete normalizedArgs[fieldName];
    else normalizedArgs[fieldName] = addresses;
  }
  if (!normalizedArgs.to?.length) failInput("`to` needs at least one recipient address");
  checkBody(args);
  const recipients = [...normalizedArgs.to, ...(normalizedArgs.cc ?? []), ...(normalizedArgs.bcc ?? []), ...(normalizedArgs.reply_to ?? [])];
  return { args: normalizedArgs, recipients };
}

/**
 * Wraps the declarative `send_email` with the checks above.
 *
 * @param operation - Generated send_email operation (object)
 * @returns Operation with `from` and `to` required (object)
 */
export function wrapSendEmail(operation) {
  return {
    ...operation,
    parameters: { ...operation.parameters, required: ["from", "to"] },
    run: (context) => {
      const { args, recipients } = normalizeSendArgs(context.args ?? {});
      assertRecipientsAllowed(context, recipients, RECIPIENT_ALLOWLIST_ENV);
      return operation.run({ ...context, args });
    },
  };
}
