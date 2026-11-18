/**
 * send_email: validates every header-bound value, applies the agent policy
 * to tool calls (tool-send-policy.mjs), loads attachments, passes the daily
 * cap, then hands the message to SMTP once. Never retried.
 */
import { assertSingleLine, normalizeMessageId, normalizeMessageIdList, parseAddressList } from "../lib/addresses.mjs";
import { loadAttachments, MAX_ATTACHMENTS } from "../lib/attachments.mjs";
import { invalidInput, setupRequired } from "../lib/errors.mjs";
import { assertToolMaySend } from "../lib/tool-send-policy.mjs";

export const MAX_RECIPIENTS = 50;
export const MAX_SUBJECT_LENGTH = 998;
export const MAX_BODY_CHARS = 5 * 1024 * 1024;
const MAX_RESPONSE_CHARS = 300;

const SEND_EMAIL_PARAMETERS = {
  type: "object",
  properties: {
    to: { type: "string", description: "Recipients, separated by commas: budi@example.com, \"Sari W\" <sari@example.com>" },
    cc: { type: "string", description: "Cc recipients, separated by commas" },
    bcc: { type: "string", description: "Bcc recipients, separated by commas" },
    subject: { type: "string", minLength: 1, description: "Subject line (no line breaks)" },
    text: { type: "string", description: "Plain-text body. Pass text, html or both" },
    html: { type: "string", description: "HTML body. Pass text, html or both" },
    reply_to: { type: "string", description: "Reply-To address(es)" },
    in_reply_to: { type: "string", description: "Message-ID being answered (from read_message.message_id), for threading" },
    references: { type: "string", description: "Message-IDs of the thread, separated by spaces (from read_message.references plus its message_id)" },
    attachments: {
      type: "array",
      maxItems: MAX_ATTACHMENTS,
      items: { type: "object" },
      description:
        "Files to attach (workflow nodes only; refused for agent tool calls): [{\"source\": \"https://... or /absolute/path inside EMAIL_ALLOWED_FILE_DIRS\", \"filename\": \"optional.pdf\", \"content_type\": \"optional/type\"}]. Up to 18 MB in total.",
    },
  },
  required: ["to", "subject"],
};

export const sendingOperations = [
  {
    name: "send_email",
    title: "Send email",
    description:
      `Send an email over SMTP from EMAIL_FROM. At most ${MAX_RECIPIENTS} recipients per message; every recipient counts toward the daily cap (EMAIL_DAILY_SEND_LIMIT). Never retried automatically. ` +
      "As an agent tool: only recipients in EMAIL_TOOL_ALLOWED_RECIPIENTS (refused when unset) and no attachments.",
    parameters: SEND_EMAIL_PARAMETERS,
    run: async ({ client, args, signal, source }) => {
      const message = buildMessage(args, client.settings);
      if (source === "tool") assertToolMaySend({ message, attachmentSpecs: args.attachments, allowlist: client.settings.toolAllowedRecipients });
      const recipientCount = message.to.length + message.cc.length + message.bcc.length;
      message.attachments = await loadAttachments(args.attachments ?? [], {
        allowedDirectories: client.settings.allowedFileDirectories,
        fetchImpl: client.fetchImpl,
        resolveHostAddresses: client.resolveHostAddresses,
        signal,
      });
      const usage = await client.getSendGuard().reserveSend(recipientCount);
      console.error(`[email] send_email to ${recipientCount} recipient(s) (${usage.sends_today}/${usage.daily_limit} today)`);
      const sendInfo = await client.sendMessage(message, signal);
      console.error(`[email] sent ${sendInfo.messageId ?? "(no id)"}: ${sendInfo.accepted?.length ?? 0} accepted, ${sendInfo.rejected?.length ?? 0} rejected`);
      return { data: shapeSendResult(sendInfo, usage, client.redact) };
    },
  },
];

/**
 * Validates arguments and builds the nodemailer message (without attachments).
 *
 * @param args - Validated send_email arguments (object)
 * @param settings - Plugin settings (object)
 * @returns nodemailer message (object)
 * @throws PluginError kinds `invalid_input`, `setup_required`
 */
export function buildMessage(args, settings) {
  const recipients = { to: parseAddressList("to", args.to), cc: parseAddressList("cc", args.cc), bcc: parseAddressList("bcc", args.bcc) };
  const recipientCount = recipients.to.length + recipients.cc.length + recipients.bcc.length;
  if (recipients.to.length === 0) throw invalidInput("`to` must list at least one address");
  if (recipientCount > MAX_RECIPIENTS) throw invalidInput(`A message may have at most ${MAX_RECIPIENTS} recipients (to + cc + bcc), got ${recipientCount}`);
  const subject = assertSingleLine("subject", args.subject);
  if (subject.length > MAX_SUBJECT_LENGTH) throw invalidInput(`\`subject\` must be at most ${MAX_SUBJECT_LENGTH} characters`);
  validateBodies(args);
  return {
    from: resolveSender(settings),
    ...recipients,
    subject,
    ...(args.text !== undefined ? { text: args.text } : {}),
    ...(args.html !== undefined ? { html: args.html } : {}),
    ...(args.reply_to ? { replyTo: parseAddressList("reply_to", args.reply_to) } : {}),
    ...(args.in_reply_to ? { inReplyTo: normalizeMessageId("in_reply_to", args.in_reply_to) } : {}),
    ...(args.references ? { references: normalizeMessageIdList("references", args.references) } : {}),
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

function validateBodies(args) {
  if (args.text === undefined && args.html === undefined) throw invalidInput("Pass `text`, `html` or both");
  for (const fieldName of ["text", "html"]) {
    if ((args[fieldName]?.length ?? 0) > MAX_BODY_CHARS) throw invalidInput(`\`${fieldName}\` must be at most ${MAX_BODY_CHARS} characters`);
  }
}

function resolveSender(settings) {
  if (!settings.from) throw setupRequired("Set EMAIL_FROM (or EMAIL_SMTP_USER) to the sender address");
  const senders = parseAddressList("EMAIL_FROM", settings.from);
  if (senders.length !== 1) throw setupRequired("EMAIL_FROM must hold exactly one address, e.g. \"Toko Budi\" <budi@example.com>");
  return senders[0];
}

function shapeSendResult(sendInfo, usage, redact) {
  const listAddresses = (addressList) => (addressList ?? []).map((entry) => (typeof entry === "string" ? entry : entry?.address ?? String(entry)));
  const rejected = listAddresses(sendInfo.rejected);
  const response = redact(sendInfo.response ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_RESPONSE_CHARS);
  return {
    sent: true,
    message_id: sendInfo.messageId ?? null,
    accepted: listAddresses(sendInfo.accepted),
    rejected,
    partially_rejected: rejected.length > 0,
    server_response: response || null,
    sends_today: usage.sends_today,
    daily_limit: usage.daily_limit,
  };
}
