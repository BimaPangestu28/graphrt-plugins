/**
 * Reading operations: chat list, chat search and messages of one chat.
 *
 * The WhatsApp Web chat list is a virtualised, scrolled list, not a paged
 * API, so these operations take `limit` but no `cursor` (next_cursor is
 * always null).
 */
import { CHAT_TARGET_PROPERTIES, resolveChatTarget, withDeadline } from "./common.mjs";

export const chatOperations = [
  {
    name: "list_chats",
    title: "List WhatsApp chats",
    description: "List chats from the top of the WhatsApp chat list: name, last message preview, time and unread count.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, default: 20, description: "Maximum chats to return" },
        unread_only: { type: "boolean", default: false, description: "Only chats with unread messages" },
      },
    },
    run: async ({ client, args, signal }) => ({
      data: await client.driver.listChats({ limit: args.limit, unreadOnly: args.unread_only, signal: withDeadline(signal) }),
    }),
  },
  {
    name: "search_chats",
    title: "Search WhatsApp chats",
    description:
      "Search chats and contacts by name or number with the WhatsApp search box; returns the matching chat and contact rows (each with `kind`), without section headers or message hits.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Text to search for" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Maximum rows to return" },
      },
      required: ["query"],
    },
    run: async ({ client, args, signal }) => ({
      data: await client.driver.searchChats({ query: args.query, limit: args.limit, signal: withDeadline(signal) }),
    }),
  },
  {
    name: "read_messages",
    title: "Read WhatsApp messages",
    description:
      "Read the last messages of a chat (by phone number or exact chat name): id, from_me, sender, time, text and delivery status. Opening a chat marks it as read on your phone.",
    parameters: {
      type: "object",
      properties: {
        ...CHAT_TARGET_PROPERTIES,
        limit: { type: "integer", minimum: 1, maximum: 200, default: 20, description: "Number of most recent messages" },
      },
    },
    run: async ({ client, args, signal }) => {
      const target = resolveChatTarget(args);
      const { chat, messages } = await client.driver.readMessages({ target, limit: args.limit, signal: withDeadline(signal) });
      return { data: { chat_name: chat.chat_name ?? target.name ?? null, phone: target.phone ?? null, messages } };
    },
  },
];
