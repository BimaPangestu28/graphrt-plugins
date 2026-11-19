/**
 * Customer service (buyer chat) operations. They need the app's customer service scope.
 * `send_message` is a POST write and is never retried after an unknown outcome.
 */
import { pathSegment } from "../lib/shared/path.mjs";
import { rejectInput, toPageTokenPage } from "../lib/client.mjs";
import { requireNumericId } from "../lib/validation.mjs";

const MAX_TEXT_LENGTH = 2000;
const MESSAGE_TYPES = ["TEXT", "IMAGE", "PRODUCT_CARD", "ORDER_CARD", "LOGISTICS_CARD", "RETURN_REFUND_CARD", "COUPON_CARD", "VIDEO"];
const CONVERSATION_ID_PROPERTY = { type: "string", minLength: 1, description: "Conversation id from get_conversations" };
const LOCALE_PROPERTY = { type: "string", description: "Language for system messages, e.g. id-ID or en" };

export const customerServiceOperations = [
  {
    name: "get_conversations",
    title: "List TikTok Shop buyer conversations",
    description: "List the shop's conversations with buyers: participants, unread count, latest message and whether the shop can reply.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 20, default: 20, description: "Page size (max 20)" },
        cursor: { type: "string", description: "next_cursor from a previous call" },
        locale: LOCALE_PROPERTY,
      },
    },
    run: async ({ client, args, signal }) => {
      const query = { page_size: args.limit, page_token: args.cursor, locale: args.locale };
      const body = await client.shop.request({ path: "/customer_service/202309/conversations", query, signal });
      return toPageTokenPage(body?.data, "conversations", args.cursor);
    },
  },
  {
    name: "get_conversation_messages",
    title: "Get TikTok Shop conversation messages",
    description: "Read messages of one buyer conversation, newest first by default. Does not mark them as read.",
    parameters: {
      type: "object",
      properties: {
        conversation_id: CONVERSATION_ID_PROPERTY,
        sort_order: { type: "string", enum: ["DESC", "ASC"], default: "DESC" },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 10, description: "Page size (max 10)" },
        cursor: { type: "string", description: "next_cursor from a previous call" },
        locale: LOCALE_PROPERTY,
      },
      required: ["conversation_id"],
    },
    run: async ({ client, args, signal }) => {
      const path = `/customer_service/202309/conversations/${pathSegment(requireNumericId("conversation_id", args.conversation_id))}/messages`;
      const query = { page_size: args.limit, page_token: args.cursor, locale: args.locale, sort_order: args.sort_order };
      const body = await client.shop.request({ path, query, signal });
      return toPageTokenPage(body?.data, "messages", args.cursor);
    },
  },
  {
    name: "send_message",
    title: "Send a TikTok Shop buyer message",
    description:
      "Send one message to the buyer in a conversation: `text` for TEXT, or `content` (e.g. {product_id} for PRODUCT_CARD, {order_id} for ORDER_CARD). " +
      "If this fails with a network error the message may have been sent: check get_conversation_messages before retrying.",
    parameters: {
      type: "object",
      properties: {
        conversation_id: CONVERSATION_ID_PROPERTY,
        message_type: { type: "string", enum: MESSAGE_TYPES, default: "TEXT", description: "Message type (sent as `type`)" },
        text: { type: "string", description: `Message text for TEXT (max ${MAX_TEXT_LENGTH} characters)` },
        content: { type: "object", description: "Message content for other types, e.g. {\"order_id\": \"580874485811283206\"}" },
      },
      required: ["conversation_id"],
    },
    run: async ({ client, args, signal }) => {
      const path = `/customer_service/202606/conversations/${pathSegment(requireNumericId("conversation_id", args.conversation_id))}/messages`;
      const json = { type: args.message_type, content: JSON.stringify(buildMessageContent(args)) };
      const body = await client.shop.request({ method: "POST", path, json, signal });
      return { data: body?.data ?? {} };
    },
  },
];

/**
 * Builds the message content object, which TikTok Shop expects JSON-serialized in `content`.
 *
 * @param args - send_message arguments (object)
 * @returns Content object (object)
 * @throws PluginError kind `invalid_input` - When TEXT has no or too long text, or another type has no content
 */
export function buildMessageContent(args) {
  if (args.message_type === "TEXT") {
    const text = args.text ?? args.content?.content;
    if (typeof text !== "string" || text.trim() === "") rejectInput("TEXT messages need `text`");
    if (text.length > MAX_TEXT_LENGTH) rejectInput(`\`text\` must have at most ${MAX_TEXT_LENGTH} characters`);
    return { content: text };
  }
  if (!args.content || Object.keys(args.content).length === 0) rejectInput(`${args.message_type} messages need \`content\``);
  return args.content;
}
