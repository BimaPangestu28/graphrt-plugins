/**
 * Sending operations. Each send passes the send guard (minimum interval and
 * daily cap) right before the message is typed, is logged to stderr and is
 * never retried automatically.
 */
import { isMediaFile, resolveAttachment } from "../lib/attachment.mjs";
import { invalidInput } from "../lib/errors.mjs";
import { CHAT_TARGET_PROPERTIES, describeChatTarget, resolveChatTarget, withDeadline } from "./common.mjs";

const MAX_TEXT_LENGTH = 65536;

export const sendingOperations = [
  {
    name: "send_message",
    title: "Send WhatsApp message",
    description:
      "Send a text message from your personal WhatsApp to a phone number or an existing chat (exact name). Rate limited; confirms the message appears as sent.",
    parameters: {
      type: "object",
      properties: {
        ...CHAT_TARGET_PROPERTIES,
        text: { type: "string", minLength: 1, description: "Message text; line breaks are kept" },
      },
      required: ["text"],
    },
    run: async ({ client, args, signal }) => {
      const target = resolveChatTarget(args);
      if (args.text.length > MAX_TEXT_LENGTH) throw tooLongText();
      const sendResult = await client.driver.sendText({
        target,
        text: args.text,
        beforeSend: () => reserveAndLogSend(client, "send_message", target, signal),
        signal: withDeadline(signal),
      });
      return { data: shapeSendResult(target, sendResult) };
    },
  },
  {
    name: "send_file",
    title: "Send WhatsApp file",
    description:
      "Send a photo, video or document (local path inside WHATSAPP_WEB_ALLOWED_FILE_DIRS, or an https URL) with an optional caption to a phone number or an existing chat.",
    parameters: {
      type: "object",
      properties: {
        ...CHAT_TARGET_PROPERTIES,
        file: { type: "string", minLength: 1, description: "Absolute local path or https URL" },
        caption: { type: "string", description: "Caption text" },
        as_document: { type: "boolean", default: false, description: "Send images/videos as a document (no compression)" },
      },
      required: ["file"],
    },
    run: async ({ client, args, signal }) => {
      const target = resolveChatTarget(args);
      if ((args.caption?.length ?? 0) > MAX_TEXT_LENGTH) throw tooLongText();
      const attachment = await resolveAttachment(args.file, { allowedDirectories: client.settings.allowedFileDirectories, fetchImpl: client.fetchImpl, signal });
      try {
        const sendResult = await client.driver.sendFile({
          target,
          filePath: attachment.filePath,
          caption: args.caption,
          asDocument: args.as_document || !isMediaFile(attachment.filePath),
          beforeSend: () => reserveAndLogSend(client, "send_file", target, signal),
          signal: withDeadline(signal),
        });
        return { data: shapeSendResult(target, sendResult) };
      } finally {
        await attachment.cleanup();
      }
    },
  },
];

async function reserveAndLogSend(client, operationName, target, signal) {
  const usage = await client.sendGuard.reserveSend({ signal });
  console.error(`[whatsapp-web] ${operationName} to ${describeChatTarget(target)} (${usage.sends_today}/${usage.daily_limit} today)`);
  return usage;
}

function shapeSendResult(target, { chat, usage, message }) {
  console.error(`[whatsapp-web] sent to ${describeChatTarget(target)}: id ${message.id}, status ${message.status}`);
  return {
    sent: true,
    chat_name: chat.chat_name ?? target.name ?? null,
    phone: target.phone ?? null,
    message_id: message.id,
    status: message.status,
    time: message.time,
    sends_today: usage.sends_today,
    daily_limit: usage.daily_limit,
  };
}

function tooLongText() {
  return invalidInput(`Text is longer than WhatsApp's ${MAX_TEXT_LENGTH} characters`);
}
