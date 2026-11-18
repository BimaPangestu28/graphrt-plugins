/**
 * Read-only bot and chat information: getMe, getChat, getChatMemberCount (GET, retried on 5xx).
 */
import { CHAT_ID_PROPERTY, checkChatId } from "../lib/arguments.mjs";
import { createBotMethodRunner } from "../lib/client.mjs";

const CHAT_PARAMETERS = { type: "object", properties: { chat_id: CHAT_ID_PROPERTY }, required: ["chat_id"] };
const buildChatParams = (args) => ({ chat_id: checkChatId(args.chat_id) });

export const infoOperations = [
  {
    name: "get_me",
    title: "Get Telegram bot info",
    description: "Return the bot's own user (id, username, name, capabilities). A quick way to check that the token works.",
    parameters: { type: "object", properties: {} },
    run: createBotMethodRunner("getMe", () => ({}), { read: true }),
  },
  {
    name: "get_chat",
    title: "Get Telegram chat",
    description: "Return up-to-date information about a chat (type, title, username, description, permissions) the bot can access.",
    parameters: CHAT_PARAMETERS,
    run: createBotMethodRunner("getChat", buildChatParams, { read: true }),
  },
  {
    name: "get_chat_member_count",
    title: "Count Telegram chat members",
    description: "Return the number of members in a group, supergroup or channel.",
    parameters: CHAT_PARAMETERS,
    run: createBotMethodRunner("getChatMemberCount", buildChatParams, { read: true }),
  },
];
