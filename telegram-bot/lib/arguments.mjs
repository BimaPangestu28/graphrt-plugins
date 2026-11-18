/**
 * Shared parameter schemas and validators for the Bot API operations.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const PARSE_MODES = ["MarkdownV2", "HTML", "Markdown"];
const CHAT_ID_PATTERN = /^-?\d+$/;
// Public usernames are 5-32 characters: a letter, then letters, digits or underscores.
const CHAT_USERNAME_PATTERN = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/;
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const HTTP_URL_PATTERN = /^https?:\/\/[^\s/]+/i;

export const CHAT_ID_PROPERTY = { type: "string", description: 'Chat id (e.g. "123456789" or "-1001234567890") or "@channelusername"' };
export const MESSAGE_ID_PROPERTY = { type: "integer", description: "Message id in the chat" };
export const PARSE_MODE_PROPERTY = { type: "string", enum: PARSE_MODES, description: "Formatting: MarkdownV2, HTML or legacy Markdown" };
export const REPLY_TO_PROPERTY = { type: "integer", description: "Reply to this message id in the same chat" };
export const DISABLE_NOTIFICATION_PROPERTY = { type: "boolean", description: "Send silently (no notification sound)" };
export const MESSAGE_THREAD_ID_PROPERTY = { type: "integer", description: "Forum topic id (forum supergroups only)" };
export const PROTECT_CONTENT_PROPERTY = { type: "boolean", description: "Prevent forwarding and saving of the sent message" };
export const REPLY_MARKUP_PROPERTY = {
  type: "object",
  description: 'Keyboard, e.g. {"inline_keyboard":[[{"text":"Yes","callback_data":"yes"}]]}, a reply keyboard, {"remove_keyboard":true} or {"force_reply":true}',
};
export const ALLOWED_UPDATES_PROPERTY = {
  type: "array",
  items: { type: "string" },
  description: 'Update types to receive, e.g. ["message","callback_query"]; [] = all except chat_member and reactions; omitted = previous setting',
};

/**
 * Throws invalid_input with a message.
 *
 * @param message - What is wrong (string)
 * @throws PluginError kind `invalid_input`
 */
export function rejectInput(message) {
  throw new PluginError(message, { kind: "invalid_input" });
}

/**
 * Checks a chat id or @username.
 *
 * @param chatId - Value to check (string)
 * @param fieldName - Argument name for the error message (string)
 * @returns The chat id (string)
 * @throws PluginError kind `invalid_input` - When it is neither a numeric id nor an @username
 */
export function checkChatId(rawChatId, fieldName = "chat_id") {
  const chatId = typeof rawChatId === "string" ? rawChatId.trim() : rawChatId;
  if (!CHAT_ID_PATTERN.test(chatId) && !CHAT_USERNAME_PATTERN.test(chatId)) {
    rejectInput(`\`${fieldName}\` must be a numeric chat id or "@username"`);
  }
  return chatId;
}

/**
 * Rejects text longer than the API allows (counted in Unicode code points).
 *
 * @param value - Text; undefined passes (string | undefined)
 * @param maxLength - Maximum characters (number)
 * @param fieldName - Name used in the error message (string)
 * @throws PluginError kind `invalid_input` - When the text is too long
 */
export function checkMaxLength(value, maxLength, fieldName) {
  if (value !== undefined && [...value].length > maxLength) rejectInput(`\`${fieldName}\` must be at most ${maxLength} characters`);
}

/**
 * Checks a photo/document reference: an http(s) URL Telegram downloads itself, or a file_id.
 * Local paths and multipart uploads are not supported in this version.
 *
 * @param fileReference - URL or file_id (string)
 * @param fieldName - Argument name for the error message (string)
 * @returns The reference (string)
 * @throws PluginError kind `invalid_input` - For local paths, attach:// references or other schemes
 */
export function checkRemoteFile(fileReference, fieldName) {
  if (HTTP_URL_PATTERN.test(fileReference) || FILE_ID_PATTERN.test(fileReference)) return fileReference;
  return rejectInput(`\`${fieldName}\` must be an http(s) URL or a Telegram file_id; local files are not supported`);
}

/**
 * Builds `reply_parameters` from a plain message id.
 *
 * @param replyToMessageId - Message id to reply to (number | undefined)
 * @returns ReplyParameters object or undefined (object | undefined)
 */
export function buildReplyParameters(replyToMessageId) {
  return replyToMessageId === undefined ? undefined : { message_id: replyToMessageId };
}
