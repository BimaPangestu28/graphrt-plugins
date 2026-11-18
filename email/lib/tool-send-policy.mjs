/**
 * What an agent (an LLM tool call) may do with send_email, as opposed to a
 * workflow node written by a person:
 *
 * - Recipients: every to, cc and bcc address must match
 *   EMAIL_TOOL_ALLOWED_RECIPIENTS (exact addresses and/or `@domain` entries,
 *   case-insensitive; a domain entry does not cover its subdomains). Unset,
 *   agents cannot send at all.
 * - Attachments: never. Local files and URLs are a way to exfiltrate data, so
 *   only workflow nodes may attach.
 *
 * Workflow nodes (`source === "node"`) are not affected.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

/**
 * Refuses a send_email tool call that the agent policy does not allow.
 *
 * @param options - Policy inputs (object)
 * @param options.message - nodemailer message from buildMessage, with `to`, `cc`, `bcc` as `[{address}]` (object)
 * @param options.attachmentSpecs - The call's `attachments` argument (object[] | undefined)
 * @param options.allowlist - `settings.toolAllowedRecipients`: `{addresses, domains}` or null (object | null)
 * @throws PluginError kind `permission_denied` - Agents disabled, an attachment, or a recipient outside the allowlist
 *
 * @example
 * if (source === "tool") assertToolMaySend({ message, attachmentSpecs: args.attachments, allowlist: settings.toolAllowedRecipients });
 */
export function assertToolMaySend({ message, attachmentSpecs, allowlist }) {
  if (!allowlist) {
    throw permissionDenied(
      "send_email is disabled for agent tool calls. To let agents send, set EMAIL_TOOL_ALLOWED_RECIPIENTS to the recipients they may email " +
        "(comma-separated addresses and/or @domains, e.g. \"budi@example.com, @toko.co.id\") and allow it in the plugin's env permissions; " +
        "workflow nodes (email.send_email) are not limited. Nothing was sent.",
    );
  }
  if ((attachmentSpecs?.length ?? 0) > 0) {
    throw permissionDenied("Agent tool calls cannot attach files or URLs to send_email; attachments are only available to workflow nodes (email.send_email). Nothing was sent.");
  }
  const refusedAddresses = [...message.to, ...message.cc, ...message.bcc].map((recipient) => recipient.address).filter((address) => !isAllowedRecipient(address, allowlist));
  if (refusedAddresses.length > 0) {
    throw permissionDenied(
      `Agent tool calls may only email recipients in EMAIL_TOOL_ALLOWED_RECIPIENTS; not allowed: ${[...new Set(refusedAddresses)].join(", ")}. Nothing was sent.`,
    );
  }
}

function isAllowedRecipient(address, allowlist) {
  const lowerAddress = address.toLowerCase();
  const domain = lowerAddress.slice(lowerAddress.lastIndexOf("@") + 1);
  return allowlist.addresses.includes(lowerAddress) || allowlist.domains.includes(domain);
}

function permissionDenied(message) {
  return new PluginError(message, { kind: "permission_denied" });
}
