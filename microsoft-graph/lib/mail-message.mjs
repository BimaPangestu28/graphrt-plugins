/**
 * Simple mail fields (to, cc, bcc, subject, body) for `send_mail` and `create_draft`, turned into Graph's message
 * resource (https://learn.microsoft.com/en-us/graph/api/resources/message). The declarative operations take the
 * whole `message` object; these wrappers give agents and workflows plain string lists instead and check the
 * recipients first (lib/recipient-policy.mjs).
 */
import { assertRecipientsAllowed, normalizeAddresses } from "./recipient-policy.mjs";

export const SEND_OPT_IN_ENV = "MICROSOFT_GRAPH_TOOL_ALLOW_SEND";
export const RECIPIENT_ALLOWLIST_ENV = "MICROSOFT_GRAPH_TOOL_RECIPIENT_ALLOWLIST";
const MAX_RECIPIENTS = 100;
const addressList = (description) => ({ type: "array", items: { type: "string" }, maxItems: MAX_RECIPIENTS, description });

export const MAIL_FIELDS = {
  to: addressList("Recipient addresses, e.g. [\"ada@example.com\"]"),
  cc: addressList("Cc addresses"),
  bcc: addressList("Bcc addresses"),
  subject: { type: "string", description: "Subject" },
  body: { type: "string", description: "Message body" },
  body_type: { type: "string", enum: ["text", "html"], default: "text", description: "Whether body is plain text or HTML" },
  importance: { type: "string", enum: ["low", "normal", "high"] },
  reply_to: addressList("Reply-To addresses"),
};

/**
 * Builds a Graph message resource from simple fields.
 *
 * @param args - Validated arguments with to/cc/bcc/subject/body/body_type/importance/reply_to (object)
 * @returns `{message, recipients}`: the resource and every recipient address (object)
 * @throws PluginError kind `invalid_input` - An address is not a plain email address
 *
 * @example
 * buildGraphMessage({ to: ["ada@example.com"], subject: "Hi", body: "Hello", body_type: "text" }).message;
 * // { subject: "Hi", body: { contentType: "Text", content: "Hello" }, toRecipients: [{ emailAddress: { address: "ada@example.com" } }] }
 */
export function buildGraphMessage(args) {
  const [to, cc, bcc, replyTo] = ["to", "cc", "bcc", "reply_to"].map((fieldName) => normalizeAddresses(args[fieldName], fieldName));
  const message = {};
  if (args.subject !== undefined) message.subject = args.subject;
  if (args.body !== undefined) message.body = { contentType: args.body_type === "html" ? "HTML" : "Text", content: args.body };
  if (args.importance) message.importance = args.importance;
  for (const [graphField, addresses] of [["toRecipients", to], ["ccRecipients", cc], ["bccRecipients", bcc], ["replyTo", replyTo]]) {
    if (addresses.length > 0) message[graphField] = addresses.map((address) => ({ emailAddress: { address } }));
  }
  return { message, recipients: [...to, ...cc, ...bcc] };
}

/**
 * Wraps the declarative `send_mail` (body `{message, saveToSentItems}`) with simple fields and the allowlist.
 *
 * @param operation - Generated send_mail operation (object)
 * @returns Operation with simple-field parameters (object)
 */
export function wrapSendMail(operation) {
  return {
    ...operation,
    parameters: { type: "object", properties: { ...MAIL_FIELDS, save_to_sent_items: { type: "boolean", default: true, description: "Keep a copy in Sent Items" } }, required: ["to", "subject", "body"] },
    run: (context) => {
      const { message, recipients } = buildGraphMessage(context.args);
      assertRecipientsAllowed(context, recipients, RECIPIENT_ALLOWLIST_ENV);
      return operation.run({ ...context, args: { message, save_to_sent_items: context.args.save_to_sent_items } });
    },
  };
}

/**
 * Wraps the declarative `create_draft` (raw message body) with simple fields. Drafts are not sent, so no allowlist.
 *
 * @param operation - Generated create_draft operation (object)
 * @returns Operation with simple-field parameters (object)
 */
export function wrapCreateDraft(operation) {
  return {
    ...operation,
    parameters: { type: "object", properties: MAIL_FIELDS, required: [] },
    run: (context) => operation.run({ ...context, args: { message: buildGraphMessage(context.args).message } }),
  };
}
