/**
 * Seller chat operations (needs Shopee's seller chat API permission for the app).
 * `sellerchat_send_message` is a POST write and is never retried after an unknown outcome.
 */
import { extractShopeeResponse, rejectInput } from "../lib/client.mjs";
import { requireIntegerId } from "../lib/validation.mjs";

const MAX_CHAT_PAGE_SIZE = 50;
const MAX_TEXT_LENGTH = 2000;
const MESSAGE_TYPES = ["text", "image", "item", "order"];

export const chatOperations = [
  {
    name: "sellerchat_get_conversation_list",
    title: "List Shopee chat conversations",
    description: "List the shop's buyer chat conversations, newest first, with unread counts and the latest message.",
    parameters: {
      type: "object",
      properties: {
        conversation_type: { type: "string", enum: ["all", "pinned", "unread"], default: "all", description: "Which conversations (sent as `type`)" },
        limit: { type: "integer", minimum: 1, maximum: MAX_CHAT_PAGE_SIZE, default: 25, description: "Page size" },
        cursor: { type: "string", description: "next_cursor from a previous call" },
      },
    },
    run: async ({ client, args, signal }) => {
      const query = { direction: "older", type: args.conversation_type, page_size: args.limit, next_timestamp_nano: args.cursor };
      const payload = extractShopeeResponse(await client.shop.request({ path: "/api/v2/sellerchat/get_conversation_list", query, signal }));
      const nextTimestamp = payload?.page_result?.next_cursor?.next_message_time_nano;
      return { data: payload?.conversations ?? [], next_cursor: payload?.page_result?.more && nextTimestamp ? String(nextTimestamp) : null };
    },
  },
  {
    name: "sellerchat_get_message",
    title: "Get Shopee chat messages",
    description: "Read messages of one chat conversation, newest first.",
    parameters: {
      type: "object",
      properties: {
        conversation_id: { type: "string", minLength: 1, description: "Conversation id from sellerchat_get_conversation_list" },
        limit: { type: "integer", minimum: 1, maximum: MAX_CHAT_PAGE_SIZE, default: 25, description: "Page size" },
        cursor: { type: "string", description: "next_cursor from a previous call" },
      },
      required: ["conversation_id"],
    },
    run: async ({ client, args, signal }) => {
      const query = { conversation_id: args.conversation_id, page_size: args.limit, offset: args.cursor };
      const payload = extractShopeeResponse(await client.shop.request({ path: "/api/v2/sellerchat/get_message", query, signal }));
      const messages = payload?.messages ?? [];
      const nextOffset = payload?.page_result?.next_offset;
      return { data: messages, next_cursor: messages.length > 0 && nextOffset && nextOffset !== args.cursor ? String(nextOffset) : null };
    },
  },
  {
    name: "sellerchat_send_message",
    title: "Send a Shopee chat message",
    description:
      "Send one message to a buyer: text, an image URL, an item card or an order card. Not for bulk messages. " +
      "If this fails with a network error the message may have been sent: check sellerchat_get_message before retrying.",
    parameters: {
      type: "object",
      properties: {
        to_id: { type: "string", minLength: 1, description: "Buyer user id (to_id / buyer_user_id)" },
        message_type: { type: "string", enum: MESSAGE_TYPES, default: "text" },
        text: { type: "string", description: `Text, for message_type text (max ${MAX_TEXT_LENGTH} characters)` },
        image_url: { type: "string", description: "Image URL from Shopee's upload_image, for message_type image" },
        item_id: { type: "string", description: "Item id, for message_type item" },
        order_sn: { type: "string", description: "Order number, for message_type order" },
      },
      required: ["to_id"],
    },
    run: async ({ client, args, signal }) => {
      const json = { to_id: requireIntegerId("to_id", args.to_id), message_type: args.message_type, content: buildMessageContent(args) };
      return { data: extractShopeeResponse(await client.shop.request({ method: "POST", path: "/api/v2/sellerchat/send_message", json, signal })) };
    },
  },
];

/**
 * Builds the `content` object for one message type.
 *
 * @param args - sellerchat_send_message arguments (object)
 * @returns Shopee message content (object)
 * @throws PluginError kind `invalid_input` - When the field the type needs is missing or text is too long
 */
export function buildMessageContent(args) {
  const contentBuilders = {
    text: () => ({ text: requireText(args.text) }),
    image: () => ({ image_url: requireField(args.image_url, "image_url", "image") }),
    item: () => ({ item_id: requireIntegerId("item_id", requireField(args.item_id, "item_id", "item")) }),
    order: () => ({ order_sn: requireField(args.order_sn, "order_sn", "order") }),
  };
  return contentBuilders[args.message_type]();
}

function requireText(text) {
  requireField(text, "text", "text");
  if (text.length > MAX_TEXT_LENGTH) rejectInput(`\`text\` must have at most ${MAX_TEXT_LENGTH} characters`);
  return text;
}

function requireField(value, fieldName, messageType) {
  if (value === undefined || value === "") rejectInput(`message_type ${messageType} needs \`${fieldName}\``);
  return value;
}
