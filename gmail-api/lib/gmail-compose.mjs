/**
 * Simple mail fields for `send_message` and `create_draft`. The declarative operations send Gmail's base64url
 * `raw`; these wrappers build it from to/cc/bcc/subject/text/html (lib/mime-message.mjs), so no caller writes
 * MIME by hand, and check the recipients of tool sends against the allowlist (lib/recipient-policy.mjs).
 */
import { buildMimeMessage, encodeRawMessage } from "./mime-message.mjs";
import { assertRecipientsAllowed } from "./recipient-policy.mjs";

export const SEND_OPT_IN_ENV = "GMAIL_TOOL_ALLOW_SEND";
export const RECIPIENT_ALLOWLIST_ENV = "GMAIL_TOOL_RECIPIENT_ALLOWLIST";
const addressList = (description) => ({ type: "array", items: { type: "string" }, maxItems: 100, description });

export const COMPOSE_FIELDS = {
  to: addressList('Recipient addresses, e.g. ["ada@example.com"] (plain addresses, no display names)'),
  cc: addressList("Cc addresses"),
  bcc: addressList("Bcc addresses"),
  reply_to: addressList("Reply-To addresses"),
  subject: { type: "string", description: "Subject (UTF-8 allowed, no line breaks)" },
  text: { type: "string", description: "Plain-text body" },
  html: { type: "string", description: "HTML body (with text, the message is multipart/alternative)" },
  thread_id: { type: "string", description: "Gmail thread id, to add the message to a thread (also set in_reply_to)" },
  in_reply_to: { type: "string", description: "Message-ID header of the message being answered, e.g. <abc@mail.gmail.com>" },
  references: { type: "string", description: "References header (default: in_reply_to)" },
};

/**
 * Wraps the declarative `send_message` (body `{raw, threadId}`).
 *
 * @param operation - Generated send_message operation (object)
 * @returns Operation taking simple fields (object)
 */
export function wrapSendMessage(operation) {
  return {
    ...operation,
    parameters: { type: "object", properties: COMPOSE_FIELDS, required: ["to", "subject"] },
    run: (context) => {
      const { mime, recipients } = buildMimeMessage(context.args);
      assertRecipientsAllowed(context, recipients, RECIPIENT_ALLOWLIST_ENV);
      return operation.run({ ...context, args: { raw: encodeRawMessage(mime), thread_id: context.args.thread_id } });
    },
  };
}

/**
 * Wraps the declarative `create_draft` (body `{message: {raw, threadId}}`). Drafts are not sent: no allowlist.
 *
 * @param operation - Generated create_draft operation (object)
 * @returns Operation taking simple fields (object)
 */
export function wrapCreateDraft(operation) {
  return {
    ...operation,
    parameters: { type: "object", properties: COMPOSE_FIELDS, required: [] },
    run: (context) => {
      const hasBody = context.args.text !== undefined || context.args.html !== undefined;
      const { mime } = buildMimeMessage(hasBody ? context.args : { ...context.args, text: "" });
      return operation.run({ ...context, args: { raw: encodeRawMessage(mime), thread_id: context.args.thread_id } });
    },
  };
}
