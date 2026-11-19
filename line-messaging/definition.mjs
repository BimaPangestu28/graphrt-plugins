/**
 * line-messaging plugin definition: the LINE Messaging API (https://developers.line.biz/en/reference/messaging-api/)
 * for a LINE Official Account bot: push and reply messages, multicast and broadcast (node only), profiles, followers,
 * group info and message quota. Built with the declarative REST layer (docs/declarative-plugins.md); channel access
 * token as a Bearer token.
 *
 * Agent policy: `push_message` needs LINE_TOOL_ALLOW_SEND=1 as a tool and the target id in
 * LINE_TOOL_RECIPIENT_ALLOWLIST (user, group or room ids; unset refuses tool pushes). `reply_message` needs the
 * opt-in only (a reply token can only answer the chat that produced it). Multicast and broadcast reach many users
 * and are node only. Push, multicast and broadcast send a fresh X-Line-Retry-Key, so a retried request is never
 * delivered twice; LINE's 409 for an already-accepted key is returned as success with `already_accepted: true`
 * (lib/retry-key-conflict.mjs).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { PluginError } from "./lib/shared/graphrt-plugin.mjs";
import { guardRecipients, wrapOperations } from "./lib/recipient-policy.mjs";
import { withRetryKeyConflictsAccepted } from "./lib/retry-key-conflict.mjs";

export const SEND_OPT_IN_ENV = "LINE_TOOL_ALLOW_SEND";
export const RECIPIENT_ALLOWLIST_ENV = "LINE_TOOL_RECIPIENT_ALLOWLIST";
const RECIPIENT_POLICY = { optInEnv: SEND_OPT_IN_ENV, allowlistEnv: RECIPIENT_ALLOWLIST_ENV, entryKind: "id" };
const SEND_POLICY = `optIn:${SEND_OPT_IN_ENV}`;
const RETRY_KEY_HEADER = "X-Line-Retry-Key";
const LINE_ID_PATTERN = /^[UCR][0-9a-f]{32}$/;
const USER_ID_PATTERN = /^U[0-9a-f]{32}$/;
const MAX_MESSAGES = 5;
const MAX_MULTICAST_RECIPIENTS = 500;

const messagesParam = {
  in: "body",
  type: "array",
  items: { type: "object" },
  maxItems: MAX_MESSAGES,
  required: true,
  description: 'Up to 5 LINE message objects, e.g. [{"type": "text", "text": "Hello"}] (text, sticker, image, video, audio, location, imagemap, template, flex)',
};
const notificationDisabled = { in: "body", type: "boolean", wireName: "notificationDisabled", description: "Send without a push notification" };
const userId = { in: "path", type: "string", required: true, description: "User id (U + 32 hex characters, from webhook events)" };
const groupId = { in: "path", type: "string", required: true, description: "Group id (C + 32 hex characters)" };

const readOperations = [
  { name: "get_bot_info", title: "Bot info", description: "The bot's user id, basic id, display name, picture and chat mode", path: "/v2/bot/info" },
  { name: "get_profile", title: "User profile", description: "Display name, picture, status message and language of a user who added the bot", path: "/v2/bot/profile/{user_id}", params: { user_id: userId } },
  {
    name: "list_followers",
    title: "Follower ids",
    description: "User ids of the bot's friends (verified or premium accounts only)",
    path: "/v2/bot/followers/ids",
    response: { dataPath: "userIds", cursorPath: "next", cursorParam: "start", limitParam: "limit", maxLimit: 1000, defaultLimit: 300 },
  },
  { name: "get_group_summary", title: "Group summary", description: "Name and picture of a group the bot is in", path: "/v2/bot/group/{group_id}/summary", params: { group_id: groupId } },
  { name: "get_group_member_count", title: "Group member count", description: "Number of users in a group", path: "/v2/bot/group/{group_id}/members/count", params: { group_id: groupId } },
  { name: "get_group_member_profile", title: "Group member profile", description: "Profile of a member of a group the bot is in", path: "/v2/bot/group/{group_id}/member/{user_id}", params: { group_id: groupId, user_id: userId } },
  { name: "get_quota", title: "Message quota", description: "This month's message limit (type none means unlimited)", path: "/v2/bot/message/quota" },
  { name: "get_quota_consumption", title: "Quota used", description: "Messages sent this month that count toward the quota", path: "/v2/bot/message/quota/consumption" },
  {
    name: "get_push_message_count",
    title: "Push messages sent",
    description: "Number of push messages sent on a day (status ready, unready or out_of_service)",
    path: "/v2/bot/message/delivery/push",
    params: { date: { in: "query", type: "string", required: true, description: "Day in yyyyMMdd, UTC+9, e.g. 20261119" } },
  },
];

const sendOperations = [
  {
    name: "validate_push_messages",
    title: "Validate messages",
    description: "Check message objects for a push without sending them (free)",
    method: "POST",
    path: "/v2/bot/message/validate/push",
    write: "idempotent",
    params: { messages: messagesParam },
  },
  {
    name: "push_message",
    title: "Push message",
    description: "Send up to 5 messages to one user, group or room at any time (counts toward the monthly quota)",
    method: "POST",
    path: "/v2/bot/message/push",
    write: "unsafe",
    idempotencyKeyHeader: RETRY_KEY_HEADER,
    toolPolicy: SEND_POLICY,
    checkHint: "get_quota_consumption or get_push_message_count for today",
    params: { to: { in: "body", type: "string", required: true, description: "User, group or room id (U/C/R + 32 hex characters)" }, messages: messagesParam, notification_disabled: notificationDisabled },
  },
  {
    name: "reply_message",
    title: "Reply",
    description: "Reply to a webhook event with its reply token (one use, valid for a short time; replies are free)",
    method: "POST",
    path: "/v2/bot/message/reply",
    write: "unsafe",
    toolPolicy: SEND_POLICY,
    checkHint: "a second reply with the same token fails with Invalid reply token, so check the chat instead",
    params: { reply_token: { in: "body", type: "string", required: true, minLength: 1, wireName: "replyToken", description: "replyToken from the webhook event" }, messages: messagesParam, notification_disabled: notificationDisabled },
  },
  {
    name: "multicast_message",
    title: "Multicast",
    description: "Send the same messages to up to 500 user ids (each recipient counts toward the quota)",
    method: "POST",
    path: "/v2/bot/message/multicast",
    write: "unsafe",
    nodeOnly: true,
    idempotencyKeyHeader: RETRY_KEY_HEADER,
    checkHint: "get_quota_consumption",
    params: { to: { in: "body", type: "array", items: { type: "string" }, maxItems: MAX_MULTICAST_RECIPIENTS, required: true, description: "User ids" }, messages: messagesParam, notification_disabled: notificationDisabled },
  },
  {
    name: "broadcast_message",
    title: "Broadcast",
    description: "Send messages to every friend of the bot (each recipient counts toward the quota)",
    method: "POST",
    path: "/v2/bot/message/broadcast",
    write: "unsafe",
    nodeOnly: true,
    idempotencyKeyHeader: RETRY_KEY_HEADER,
    checkHint: "get_quota_consumption",
    params: { messages: messagesParam, notification_disabled: notificationDisabled },
  },
  {
    name: "show_loading_animation",
    title: "Loading animation",
    description: "Show a typing/loading indicator in a one-on-one chat while the bot prepares a reply",
    method: "POST",
    path: "/v2/bot/chat/loading/start",
    write: "idempotent",
    params: {
      chat_id: { in: "body", type: "string", required: true, wireName: "chatId", description: "User id of the chat" },
      loading_seconds: { in: "body", type: "integer", enum: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60], wireName: "loadingSeconds", description: "Seconds (multiple of 5, default 20)" },
    },
  },
];

const restDefinition = defineRestPlugin({
  name: "line-messaging",
  version: "0.1.0",
  description: "LINE Messaging API: push and reply messages, multicast and broadcast (node only), profiles, followers, groups and quota; agent pushes need an opt-in and a recipient id allowlist",
  apiName: "LINE Messaging API",
  baseUrl: "https://api.line.me",
  auth: { type: "bearer", env: "LINE_CHANNEL_ACCESS_TOKEN" },
  extraEnv: [RECIPIENT_ALLOWLIST_ENV],
  // Errors are {message, details: [{message, property}]}; 409 means the retry key was already accepted.
  errors: { messagePath: "message" },
  apiRequest: { examplePath: "/v2/bot/info" },
  operations: [...readOperations, ...sendOperations],
});

/**
 * Checks a LINE id before it goes into a request.
 *
 * @param rawId - Id to check (string)
 * @param argumentName - Parameter name for the message (string)
 * @param pattern - USER_ID_PATTERN or LINE_ID_PATTERN (RegExp)
 * @returns The id (string)
 * @throws PluginError kind `invalid_input` - Not a LINE id
 */
function requireLineId(rawId, argumentName, pattern) {
  const lineId = String(rawId ?? "").trim();
  if (!pattern.test(lineId)) throw new PluginError(`\`${argumentName}\` must be a LINE ${pattern === USER_ID_PATTERN ? "user id (U" : "user, group or room id (U/C/R"} + 32 hex characters, from webhook events), got ${JSON.stringify(lineId.slice(0, 40))}`, { kind: "invalid_input" });
  return lineId;
}

const preparePush = (args) => {
  const to = requireLineId(args.to, "to", LINE_ID_PATTERN);
  return { args: { ...args, to }, recipients: [to] };
};
const prepareMulticast = (args) => ({ args: { ...args, to: args.to.map((recipientId, index) => requireLineId(recipientId, `to[${index}]`, USER_ID_PATTERN)) }, recipients: [] });

export const pluginDefinition = withRetryKeyConflictsAccepted(wrapOperations(restDefinition, {
  push_message: (operation) => guardRecipients(operation, preparePush, RECIPIENT_POLICY),
  multicast_message: (operation) => guardRecipients(operation, prepareMulticast, RECIPIENT_POLICY),
}));
