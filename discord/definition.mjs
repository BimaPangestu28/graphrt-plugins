/**
 * discord plugin definition: the Discord REST API v10 with a bot token (https://discord.com/developers/docs/reference).
 * Guilds, channels, messages, reactions, members and threads. Built with the declarative REST layer
 * (docs/declarative-plugins.md).
 *
 * Agent policy: sending and editing messages and starting threads need DISCORD_TOOL_ALLOW_SEND=1 as tools;
 * deleting messages is node only. New messages default to `allowed_mentions: {parse: []}`, so no @everyone, role
 * or user ping happens unless the caller asks for it; tool calls need DISCORD_TOOL_ALLOW_MASS_MENTIONS=1 to ping
 * @everyone/@here or roles (lib/mention-policy.mjs).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardMassMentions, MASS_MENTIONS_ENV } from "./lib/mention-policy.mjs";

const SEND_POLICY = "optIn:DISCORD_TOOL_ALLOW_SEND";
const snowflake = (description) => ({ in: "path", type: "string", required: true, description });
const GUILD_ID = snowflake("Server (guild) id");
const CHANNEL_ID = snowflake("Channel or thread id");
const MESSAGE_ID = snowflake("Message id");
const EMOJI = { in: "path", type: "string", required: true, description: "Unicode emoji (👍) or custom emoji as name:id" };
const afterId = (maxLimit, itemIdPath = "id") => ({ lastItemCursor: { itemIdPath, param: "after" }, limitParam: "limit", maxLimit, defaultLimit: Math.min(maxLimit, 100) });
const messageBody = {
  content: { in: "body", type: "string", description: "Text, up to 2000 characters" },
  embeds: { in: "body", type: "array", items: { type: "object" }, maxItems: 10, description: "Embed objects" },
  allowed_mentions: { in: "body", type: "object", default: { parse: [] }, description: 'Which mentions ping, default none; e.g. {"parse": ["users"]}' },
};
const autoArchive = { in: "body", type: "integer", enum: [60, 1440, 4320, 10080], description: "Minutes of inactivity before the thread is archived" };

const userAndGuildOperations = [
  { name: "get_current_user", title: "Bot user", description: "The bot's own user", path: "/users/@me" },
  {
    name: "list_my_guilds",
    title: "List servers",
    description: "Servers (guilds) the bot is in",
    path: "/users/@me/guilds",
    params: { with_counts: { in: "query", type: "boolean", description: "Add approximate member and presence counts" } },
    response: afterId(200),
  },
  { name: "get_guild", title: "Get server", description: "One server", path: "/guilds/{guild_id}", params: { guild_id: GUILD_ID, with_counts: { in: "query", type: "boolean" } } },
  { name: "list_guild_channels", title: "List channels", description: "Channels of a server (not threads)", path: "/guilds/{guild_id}/channels", params: { guild_id: GUILD_ID } },
  {
    name: "list_guild_members",
    title: "List members",
    description: "Members of a server (needs the privileged Server Members intent)",
    path: "/guilds/{guild_id}/members",
    params: { guild_id: GUILD_ID },
    response: afterId(1000, "user.id"),
  },
  {
    name: "search_guild_members",
    title: "Search members",
    description: "Members whose username or nickname starts with a query",
    path: "/guilds/{guild_id}/members/search",
    params: { guild_id: GUILD_ID, query: { in: "query", type: "string", required: true, minLength: 1 }, limit: { in: "query", type: "integer", min: 1, max: 1000, default: 20 } },
  },
  { name: "get_guild_member", title: "Get member", description: "One member of a server", path: "/guilds/{guild_id}/members/{user_id}", params: { guild_id: GUILD_ID, user_id: snowflake("User id") } },
];

const channelAndMessageReads = [
  { name: "get_channel", title: "Get channel", description: "A channel or thread", path: "/channels/{channel_id}", params: { channel_id: CHANNEL_ID } },
  {
    name: "list_messages",
    title: "List messages",
    description: "Messages of a channel, newest first (needs the Message Content intent to see content of others' messages)",
    path: "/channels/{channel_id}/messages",
    params: { channel_id: CHANNEL_ID },
    // Discord returns newest first; the next page is the messages before the last (oldest) one.
    response: { lastItemCursor: { itemIdPath: "id", param: "before" }, limitParam: "limit", maxLimit: 100, defaultLimit: 50 },
  },
  { name: "get_message", title: "Get message", description: "One message", path: "/channels/{channel_id}/messages/{message_id}", params: { channel_id: CHANNEL_ID, message_id: MESSAGE_ID } },
  {
    name: "list_reactions",
    title: "Users who reacted",
    description: "Users who reacted to a message with one emoji",
    path: "/channels/{channel_id}/messages/{message_id}/reactions/{emoji}",
    params: { channel_id: CHANNEL_ID, message_id: MESSAGE_ID, emoji: EMOJI },
    response: afterId(100),
  },
  { name: "list_active_threads", title: "Active threads", description: "Active threads of a server", path: "/guilds/{guild_id}/threads/active", params: { guild_id: GUILD_ID } },
  {
    name: "list_public_archived_threads",
    title: "Archived threads",
    description: "Archived public threads of a channel, newest first (has_more says whether to ask again with before)",
    path: "/channels/{channel_id}/threads/archived/public",
    params: { channel_id: CHANNEL_ID, before: { in: "query", type: "string", description: "ISO 8601 timestamp: threads archived before it" }, limit: { in: "query", type: "integer", min: 2, max: 100 } },
  },
];

const writeOperations = [
  {
    name: "send_message",
    title: "Send message",
    description: "Send a message to a channel or thread (optionally as a reply)",
    method: "POST",
    path: "/channels/{channel_id}/messages",
    write: "unsafe",
    toolPolicy: SEND_POLICY,
    checkHint: "list_messages for the channel and look for the content",
    params: { channel_id: CHANNEL_ID, ...messageBody, reply_to: { in: "body", type: "string", wireName: "message_reference.message_id", description: "Message id to reply to" } },
  },
  {
    name: "edit_message",
    title: "Edit message",
    description: "Edit a message the bot sent",
    method: "PATCH",
    path: "/channels/{channel_id}/messages/{message_id}",
    write: "idempotent",
    toolPolicy: SEND_POLICY,
    params: { channel_id: CHANNEL_ID, message_id: MESSAGE_ID, content: messageBody.content, embeds: messageBody.embeds },
  },
  {
    name: "delete_message",
    title: "Delete message",
    description: "Delete a message",
    method: "DELETE",
    path: "/channels/{channel_id}/messages/{message_id}",
    write: "idempotent",
    nodeOnly: true,
    params: { channel_id: CHANNEL_ID, message_id: MESSAGE_ID },
  },
  {
    name: "add_reaction",
    title: "Add reaction",
    description: "React to a message as the bot",
    method: "PUT",
    path: "/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me",
    write: "idempotent",
    params: { channel_id: CHANNEL_ID, message_id: MESSAGE_ID, emoji: EMOJI },
  },
  {
    name: "remove_own_reaction",
    title: "Remove reaction",
    description: "Remove the bot's reaction from a message",
    method: "DELETE",
    path: "/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me",
    write: "idempotent",
    params: { channel_id: CHANNEL_ID, message_id: MESSAGE_ID, emoji: EMOJI },
  },
  {
    name: "start_thread_from_message",
    title: "Thread from message",
    description: "Start a thread on an existing message",
    method: "POST",
    path: "/channels/{channel_id}/messages/{message_id}/threads",
    write: "unsafe",
    toolPolicy: SEND_POLICY,
    checkHint: "get_message and look at its thread",
    params: { channel_id: CHANNEL_ID, message_id: MESSAGE_ID, name: { in: "body", type: "string", required: true, minLength: 1 }, auto_archive_duration: autoArchive },
  },
  {
    name: "start_thread",
    title: "Start thread",
    description: "Start a thread without a starter message (public by default)",
    method: "POST",
    path: "/channels/{channel_id}/threads",
    write: "unsafe",
    toolPolicy: SEND_POLICY,
    checkHint: "list_active_threads for the server and look for the name",
    params: {
      channel_id: CHANNEL_ID,
      name: { in: "body", type: "string", required: true, minLength: 1 },
      type: { in: "body", type: "integer", enum: [11, 12], default: 11, description: "11 public thread, 12 private thread" },
      auto_archive_duration: autoArchive,
      invitable: { in: "body", type: "boolean", description: "Private threads: whether non-moderators can add members" },
    },
  },
];

const restDefinition = defineRestPlugin({
  name: "discord",
  version: "0.1.0",
  description: "Discord bot (REST API v10): servers, channels, messages, reactions, members and threads; agent sends need an opt-in",
  apiName: "Discord REST API",
  baseUrl: "https://discord.com/api/v10",
  auth: { type: "header", header: "Authorization", prefix: "Bot ", env: "DISCORD_BOT_TOKEN" },
  // Discord asks bots to identify themselves this way (https://discord.com/developers/docs/reference#user-agent).
  defaultHeaders: { "user-agent": "DiscordBot (https://github.com/BimaPangestu28/graphrt-plugins, 0.1.0)" },
  // Errors are {"code": 50001, "message": "Missing Access", "errors": {...}}; 429s add retry_after (seconds).
  errors: {
    messagePath: "message",
    codePath: "code",
    kindByCode: {
      10003: "not_found",
      10004: "not_found",
      10007: "not_found",
      10008: "not_found",
      10013: "not_found",
      10014: "not_found",
      40001: "auth_error",
      50001: "permission_denied",
      50013: "permission_denied",
      50035: "invalid_input",
      50006: "invalid_input",
    },
    retryAfterPath: "retry_after",
  },
  extraEnv: [MASS_MENTIONS_ENV],
  apiRequest: { examplePath: "/users/@me" },
  operations: [...userAndGuildOperations, ...channelAndMessageReads, ...writeOperations],
});

export const pluginDefinition = { ...restDefinition, operations: restDefinition.operations.map((operation) => (operation.name === "send_message" ? guardMassMentions(operation) : operation)) };
