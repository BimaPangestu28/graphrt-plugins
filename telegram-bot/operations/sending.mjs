/**
 * Sending operations: sendMessage, sendPhoto, sendDocument, sendChatAction.
 *
 * Sends are POSTs: the shared client never retries them after an unknown outcome (timeout, network
 * error, 5xx), so a message is never sent twice. 429 is retried after Telegram's retry_after.
 * Photos and documents are sent by URL (Telegram downloads them: photos up to 5 MB, other files up to
 * 20 MB; documents by URL only work for PDF and ZIP) or by file_id. Local file upload is not supported.
 */
import {
  CHAT_ID_PROPERTY,
  DISABLE_NOTIFICATION_PROPERTY,
  MESSAGE_THREAD_ID_PROPERTY,
  PARSE_MODE_PROPERTY,
  PROTECT_CONTENT_PROPERTY,
  REPLY_MARKUP_PROPERTY,
  REPLY_TO_PROPERTY,
  buildReplyParameters,
  checkChatId,
  checkMaxLength,
  checkRemoteFile,
} from "../lib/arguments.mjs";
import { createBotMethodRunner } from "../lib/client.mjs";

const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;
const CHAT_ACTIONS = [
  "typing",
  "upload_photo",
  "record_video",
  "upload_video",
  "record_voice",
  "upload_voice",
  "upload_document",
  "choose_sticker",
  "find_location",
  "record_video_note",
  "upload_video_note",
];

const COMMON_SEND_PROPERTIES = {
  reply_to_message_id: REPLY_TO_PROPERTY,
  disable_notification: DISABLE_NOTIFICATION_PROPERTY,
  protect_content: PROTECT_CONTENT_PROPERTY,
  message_thread_id: MESSAGE_THREAD_ID_PROPERTY,
  reply_markup: REPLY_MARKUP_PROPERTY,
};

function buildCommonSendParams(args) {
  return {
    chat_id: checkChatId(args.chat_id),
    message_thread_id: args.message_thread_id,
    disable_notification: args.disable_notification,
    protect_content: args.protect_content,
    reply_parameters: buildReplyParameters(args.reply_to_message_id),
    reply_markup: args.reply_markup,
  };
}

// The limit applies after entity parsing, so marked-up text is left for Telegram to check.
function buildMessageParams(args) {
  if (!args.parse_mode) checkMaxLength(args.text, TEXT_LIMIT, "text");
  const linkPreviewOptions = args.disable_link_preview ? { is_disabled: true } : undefined;
  return { ...buildCommonSendParams(args), text: args.text, parse_mode: args.parse_mode, link_preview_options: linkPreviewOptions };
}

function buildMediaParams(args, mediaField) {
  if (!args.parse_mode) checkMaxLength(args.caption, CAPTION_LIMIT, "caption");
  return {
    ...buildCommonSendParams(args),
    [mediaField]: checkRemoteFile(args[mediaField], mediaField),
    caption: args.caption,
    parse_mode: args.parse_mode,
    has_spoiler: args.has_spoiler,
  };
}

function mediaProperties(mediaField, mediaDescription) {
  return {
    chat_id: CHAT_ID_PROPERTY,
    [mediaField]: { type: "string", description: mediaDescription },
    caption: { type: "string", description: `Caption (up to ${CAPTION_LIMIT} characters after formatting)` },
    parse_mode: PARSE_MODE_PROPERTY,
    ...COMMON_SEND_PROPERTIES,
  };
}

export const sendingOperations = [
  {
    name: "send_message",
    title: "Send Telegram message",
    description: "Send a text message to a chat, optionally formatted, as a reply, silent, or with an inline/reply keyboard. Never resent automatically.",
    parameters: {
      type: "object",
      properties: {
        chat_id: CHAT_ID_PROPERTY,
        text: { type: "string", description: `Message text (1-${TEXT_LIMIT} characters after formatting)` },
        parse_mode: PARSE_MODE_PROPERTY,
        disable_link_preview: { type: "boolean", description: "Do not show a link preview" },
        ...COMMON_SEND_PROPERTIES,
      },
      required: ["chat_id", "text"],
    },
    run: createBotMethodRunner("sendMessage", buildMessageParams),
  },
  {
    name: "send_photo",
    title: "Send Telegram photo",
    description: "Send a photo by http(s) URL (Telegram downloads it, max 5 MB) or by file_id. Local files are not supported.",
    parameters: {
      type: "object",
      properties: {
        ...mediaProperties("photo", "Photo URL (http/https) or file_id of a photo already on Telegram"),
        has_spoiler: { type: "boolean", description: "Cover the photo with a spoiler animation" },
      },
      required: ["chat_id", "photo"],
    },
    run: createBotMethodRunner("sendPhoto", (args) => buildMediaParams(args, "photo")),
  },
  {
    name: "send_document",
    title: "Send Telegram document",
    description: "Send a file by http(s) URL (Telegram downloads it, max 20 MB, PDF or ZIP only) or by file_id. Local files are not supported.",
    parameters: {
      type: "object",
      properties: mediaProperties("document", "File URL (http/https, PDF or ZIP) or file_id of a file already on Telegram"),
      required: ["chat_id", "document"],
    },
    run: createBotMethodRunner("sendDocument", (args) => buildMediaParams(args, "document")),
  },
  {
    name: "send_chat_action",
    title: "Send Telegram chat action",
    description: 'Show a status such as "typing…" in the chat for up to 5 seconds (until the bot\'s next message).',
    parameters: {
      type: "object",
      properties: { chat_id: CHAT_ID_PROPERTY, action: { type: "string", enum: CHAT_ACTIONS, default: "typing" }, message_thread_id: MESSAGE_THREAD_ID_PROPERTY },
      required: ["chat_id"],
    },
    run: createBotMethodRunner("sendChatAction", (args) => ({ chat_id: checkChatId(args.chat_id), action: args.action, message_thread_id: args.message_thread_id })),
  },
];
