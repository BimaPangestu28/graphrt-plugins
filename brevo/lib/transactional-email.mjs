/**
 * Recipient checks for Brevo's transactional send (`POST /smtp/email`): every to/cc/bcc and reply-to address must
 * be a plain email address (for every caller), and agent tool sends must match BREVO_TOOL_RECIPIENT_ALLOWLIST
 * when it is set (lib/recipient-policy.mjs). Tool sends also may not set address headers through `email_headers`
 * (To, Cc, Bcc, Reply-To, From, Sender), which would add recipients the allowlist never saw.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { assertRecipientsAllowed, normalizeAddresses } from "./recipient-policy.mjs";

export const SEND_OPT_IN_ENV = "BREVO_TOOL_ALLOW_SEND";
export const RECIPIENT_ALLOWLIST_ENV = "BREVO_TOOL_RECIPIENT_ALLOWLIST";
const RECIPIENT_FIELDS = ["to", "cc", "bcc"];
const ADDRESS_HEADER_NAMES = new Set(["to", "cc", "bcc", "reply-to", "from", "sender"]);

/**
 * Lists and checks every recipient address of a send.
 *
 * @param args - Send arguments with `to`, `cc`, `bcc` arrays of `{email, name?}` and `reply_to_email` (object)
 * @returns Trimmed addresses (string[])
 * @throws PluginError kind `invalid_input` - A recipient has no plain email address
 *
 * @example
 * collectRecipientAddresses({ to: [{ email: "ada@example.com" }] }); // ["ada@example.com"]
 */
export function collectRecipientAddresses(args) {
  const recipientAddresses = RECIPIENT_FIELDS.flatMap((fieldName) => normalizeAddresses((args[fieldName] ?? []).map((recipient) => recipient?.email), `${fieldName}[].email`));
  const replyToAddresses = args.reply_to_email ? normalizeAddresses([args.reply_to_email], "reply_to_email") : [];
  return [...recipientAddresses, ...replyToAddresses];
}

/**
 * Refuses a tool send whose custom headers set an address header (compared case-insensitively).
 *
 * @param context - Operation context `{source, args}` (object)
 * @returns Nothing
 * @throws PluginError kind `permission_denied` - A tool call sets To, Cc, Bcc, Reply-To, From or Sender
 */
export function assertNoAddressHeadersForTools({ source, args }) {
  if (source !== "tool" || !args.email_headers || typeof args.email_headers !== "object") return;
  const addressHeaders = Object.keys(args.email_headers).filter((headerName) => ADDRESS_HEADER_NAMES.has(headerName.trim().toLowerCase()));
  if (addressHeaders.length === 0) return;
  throw new PluginError(`Agent tools may not set address headers in email_headers (${addressHeaders.join(", ")}); use to/cc/bcc/reply_to_email`, { kind: "permission_denied" });
}

/**
 * Wraps the declarative send so recipients are validated, and checked against the allowlist and the address-header
 * rule for tools, before the request (the opt-in itself is the operation's toolPolicy).
 *
 * @param operation - Generated send_transactional_email operation (object)
 * @returns Operation with the recipient checks (object)
 */
export function wrapTransactionalSend(operation) {
  return {
    ...operation,
    run: (context) => {
      const recipientAddresses = collectRecipientAddresses(context.args);
      assertNoAddressHeadersForTools(context);
      assertRecipientsAllowed(context, recipientAddresses, RECIPIENT_ALLOWLIST_ENV);
      return operation.run(context);
    },
  };
}
