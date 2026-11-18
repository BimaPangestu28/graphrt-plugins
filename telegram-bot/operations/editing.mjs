/**
 * Changing existing messages and answering button presses: editMessageText, deleteMessage,
 * forwardMessage, answerCallbackQuery. All are POSTs and never retried after an unknown outcome.
 */
import {
  CHAT_ID_PROPERTY,
  DISABLE_NOTIFICATION_PROPERTY,
  MESSAGE_ID_PROPERTY,
  MESSAGE_THREAD_ID_PROPERTY,
  PARSE_MODE_PROPERTY,
  PROTECT_CONTENT_PROPERTY,
  checkChatId,
  checkMaxLength,
  rejectInput,
} from "../lib/arguments.mjs";
import { createBotMethodRunner } from "../lib/client.mjs";

const TEXT_LIMIT = 4096;
const CALLBACK_TEXT_LIMIT = 200;

// A message is addressed either by chat_id + message_id or by inline_message_id, never both.
function buildEditTarget(args) {
  const hasChatMessage = args.chat_id !== undefined || args.message_id !== undefined;
  if (args.inline_message_id !== undefined && hasChatMessage) rejectInput("Pass `chat_id` + `message_id` or `inline_message_id`, not both");
  if (args.inline_message_id !== undefined) return { inline_message_id: args.inline_message_id };
  if (args.chat_id === undefined || args.message_id === undefined) rejectInput("Pass `chat_id` and `message_id` (or `inline_message_id`)");
  return { chat_id: checkChatId(args.chat_id), message_id: args.message_id };
}

function buildEditParams(args) {
  if (!args.parse_mode) checkMaxLength(args.text, TEXT_LIMIT, "text");
  const linkPreviewOptions = args.disable_link_preview ? { is_disabled: true } : undefined;
  return { ...buildEditTarget(args), text: args.text, parse_mode: args.parse_mode, link_preview_options: linkPreviewOptions, reply_markup: args.reply_markup };
}

function buildCallbackAnswerParams(args) {
  checkMaxLength(args.text, CALLBACK_TEXT_LIMIT, "text");
  return { callback_query_id: args.callback_query_id, text: args.text, show_alert: args.show_alert, url: args.url, cache_time: args.cache_time };
}

export const editingOperations = [
  {
    name: "edit_message_text",
    title: "Edit Telegram message text",
    description: "Replace the text (and inline keyboard) of a message the bot sent, by chat_id + message_id or inline_message_id.",
    parameters: {
      type: "object",
      properties: {
        chat_id: CHAT_ID_PROPERTY,
        message_id: MESSAGE_ID_PROPERTY,
        inline_message_id: { type: "string", description: "Inline message id (instead of chat_id + message_id)" },
        text: { type: "string", description: `New text (1-${TEXT_LIMIT} characters after formatting)` },
        parse_mode: PARSE_MODE_PROPERTY,
        disable_link_preview: { type: "boolean", description: "Do not show a link preview" },
        reply_markup: { type: "object", description: 'Inline keyboard, e.g. {"inline_keyboard":[[{"text":"Done","callback_data":"done"}]]}' },
      },
      required: ["text"],
    },
    run: createBotMethodRunner("editMessageText", buildEditParams),
  },
  {
    name: "delete_message",
    title: "Delete Telegram message",
    description: "Delete a message sent less than 48 h ago: the bot's own messages, incoming messages in private chats, or any message where the bot is an admin with delete rights.",
    parameters: { type: "object", properties: { chat_id: CHAT_ID_PROPERTY, message_id: MESSAGE_ID_PROPERTY }, required: ["chat_id", "message_id"] },
    run: createBotMethodRunner("deleteMessage", (args) => ({ chat_id: checkChatId(args.chat_id), message_id: args.message_id })),
  },
  {
    name: "forward_message",
    title: "Forward Telegram message",
    description: "Forward a message from one chat to another. Messages with protected content cannot be forwarded.",
    parameters: {
      type: "object",
      properties: {
        chat_id: { ...CHAT_ID_PROPERTY, description: "Target chat id or @channelusername" },
        from_chat_id: { ...CHAT_ID_PROPERTY, description: "Chat the message is in" },
        message_id: MESSAGE_ID_PROPERTY,
        disable_notification: DISABLE_NOTIFICATION_PROPERTY,
        protect_content: PROTECT_CONTENT_PROPERTY,
        message_thread_id: MESSAGE_THREAD_ID_PROPERTY,
      },
      required: ["chat_id", "from_chat_id", "message_id"],
    },
    run: createBotMethodRunner("forwardMessage", (args) => ({
      chat_id: checkChatId(args.chat_id),
      from_chat_id: checkChatId(args.from_chat_id, "from_chat_id"),
      message_id: args.message_id,
      disable_notification: args.disable_notification,
      protect_content: args.protect_content,
      message_thread_id: args.message_thread_id,
    })),
  },
  {
    name: "answer_callback_query",
    title: "Answer Telegram button press",
    description: "Answer an inline-keyboard button press (callback_query id from get_updates): show a short notification or alert, or stop the loading spinner.",
    parameters: {
      type: "object",
      properties: {
        callback_query_id: { type: "string", description: "callback_query.id from the update" },
        text: { type: "string", description: `Notification text (up to ${CALLBACK_TEXT_LIMIT} characters)` },
        show_alert: { type: "boolean", description: "Show an alert dialog instead of a notification" },
        url: { type: "string", description: "URL to open (games, or t.me/<bot>?start=... links)" },
        cache_time: { type: "integer", minimum: 0, description: "Seconds the client may cache this answer" },
      },
      required: ["callback_query_id"],
    },
    run: createBotMethodRunner("answerCallbackQuery", buildCallbackAnswerParams),
  },
];
