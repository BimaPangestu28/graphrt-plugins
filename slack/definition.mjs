/**
 * slack plugin definition: the Slack Web API (https://docs.slack.dev/reference/methods) with a bot token.
 * Conversations, history and threads, posting and editing messages, reactions, users, file uploads (v2 external
 * flow) and message search (user token). Built with the declarative REST layer (docs/declarative-plugins.md);
 * `upload_file` and `search_messages` are hand-written (see lib/).
 *
 * Agent policy: posting, editing and uploading need SLACK_TOOL_ALLOW_SEND=1 as tools; deleting is node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { restrictApiRequestForTools } from "./lib/api-request-policy.mjs";
import { SLACK_ERRORS } from "./lib/slack-errors.mjs";
import { searchMessagesOperation, USER_TOKEN_ENV } from "./lib/search-messages.mjs";
import { SEND_OPT_IN_ENV, UPLOAD_DIR_ENV, uploadFileOperation } from "./lib/upload-file.mjs";

const SEND_POLICY = `optIn:${SEND_OPT_IN_ENV}`;
const JSON_UTF8 = "application/json; charset=utf-8";
const channelParam = (description = "Conversation id, e.g. C0123456789") => ({ in: "query", type: "string", required: true, description });
const slackCursor = (dataPath, maxLimit) => ({ dataPath, cursorPath: "response_metadata.next_cursor", cursorParam: "cursor", limitParam: "limit", maxLimit, defaultLimit: 100 });
const historyWindow = {
  oldest: { in: "query", type: "string", description: "Only messages after this ts (Unix seconds, e.g. 1731990000.000000)" },
  latest: { in: "query", type: "string", description: "Only messages before this ts" },
  inclusive: { in: "query", type: "boolean", description: "Include messages exactly at oldest/latest" },
};

const readOperations = [
  { name: "auth_test", title: "Check token", description: "Who the token belongs to: team, user and bot ids", path: "/auth.test" },
  {
    name: "list_conversations",
    title: "List conversations",
    description: "List channels the token can see (public by default; private, mpim and im with the matching scopes)",
    path: "/conversations.list",
    params: {
      types: { in: "query", type: "array", items: { type: "string", enum: ["public_channel", "private_channel", "mpim", "im"] }, description: "Conversation types (default public_channel)" },
      exclude_archived: { in: "query", type: "boolean", default: true, description: "Skip archived channels" },
      team_id: { in: "query", type: "string", description: "Workspace id (Enterprise Grid org tokens only)" },
    },
    response: slackCursor("channels", 1000),
  },
  {
    name: "get_conversation_info",
    title: "Get conversation",
    description: "Details of one conversation: name, topic, purpose, membership",
    path: "/conversations.info",
    params: { channel: channelParam(), include_num_members: { in: "query", type: "boolean", description: "Add num_members" } },
    response: { dataPath: "channel" },
  },
  {
    name: "get_conversation_history",
    title: "Channel history",
    description: "Messages of a conversation, newest first (thread replies are fetched with get_thread_replies)",
    path: "/conversations.history",
    params: { channel: channelParam(), ...historyWindow },
    response: slackCursor("messages", 999),
  },
  {
    name: "get_thread_replies",
    title: "Thread replies",
    description: "A thread: the parent message followed by its replies",
    path: "/conversations.replies",
    params: { channel: channelParam(), ts: { in: "query", type: "string", required: true, description: "ts of the thread's parent message" }, ...historyWindow },
    response: slackCursor("messages", 999),
  },
  {
    name: "get_permalink",
    title: "Message link",
    description: "Permanent URL of a message",
    path: "/chat.getPermalink",
    params: { channel: channelParam(), message_ts: { in: "query", type: "string", required: true, description: "Message ts" } },
  },
  {
    name: "get_reactions",
    title: "Get reactions",
    description: "Reactions on a message",
    path: "/reactions.get",
    params: { channel: channelParam(), timestamp: { in: "query", type: "string", required: true, description: "Message ts" }, full: { in: "query", type: "boolean", description: "Return every reacting user" } },
    response: { dataPath: "message" },
  },
  {
    name: "list_users",
    title: "List users",
    description: "Members of the workspace (needs users:read; emails need users:read.email)",
    path: "/users.list",
    params: { include_locale: { in: "query", type: "boolean" }, team_id: { in: "query", type: "string", description: "Workspace id (Enterprise Grid org tokens only)" } },
    response: slackCursor("members", 1000),
  },
  {
    name: "get_user_info",
    title: "Get user",
    description: "Profile of one user",
    path: "/users.info",
    params: { user: { in: "query", type: "string", required: true, description: "User id, e.g. U0123456789" }, include_locale: { in: "query", type: "boolean" } },
    response: { dataPath: "user" },
  },
  {
    name: "lookup_user_by_email",
    title: "Find user by email",
    description: "Find a user by email address (needs users:read.email)",
    path: "/users.lookupByEmail",
    params: { email: { in: "query", type: "string", required: true, minLength: 3 } },
    response: { dataPath: "user" },
  },
];

const messageContent = {
  text: { in: "body", type: "string", description: "Message text (mrkdwn); required unless blocks are given, and used as the notification fallback" },
  blocks: { in: "body", type: "array", items: { type: "object" }, maxItems: 50, description: "Block Kit blocks" },
};

const writeOperations = [
  {
    name: "post_message",
    title: "Post message",
    description: "Post a message to a channel, DM or thread",
    method: "POST",
    path: "/chat.postMessage",
    contentType: JSON_UTF8,
    write: "unsafe",
    toolPolicy: SEND_POLICY,
    checkHint: "get_conversation_history (or get_thread_replies) for the channel and look for the text",
    params: {
      channel: { in: "body", type: "string", required: true, description: "Channel, DM or user id" },
      ...messageContent,
      thread_ts: { in: "body", type: "string", description: "Parent message ts, to reply in its thread" },
      reply_broadcast: { in: "body", type: "boolean", description: "Also show a thread reply in the channel" },
      unfurl_links: { in: "body", type: "boolean" },
      unfurl_media: { in: "body", type: "boolean" },
      mrkdwn: { in: "body", type: "boolean", description: "Format text as mrkdwn (default true)" },
    },
  },
  {
    name: "update_message",
    title: "Edit message",
    description: "Replace the text or blocks of a message the token posted",
    method: "POST",
    path: "/chat.update",
    contentType: JSON_UTF8,
    // Sending the same edit twice leaves the same message.
    write: "idempotent",
    toolPolicy: SEND_POLICY,
    params: { channel: { in: "body", type: "string", required: true }, ts: { in: "body", type: "string", required: true, description: "ts of the message to edit" }, ...messageContent },
  },
  {
    name: "delete_message",
    title: "Delete message",
    description: "Delete a message permanently",
    method: "POST",
    path: "/chat.delete",
    contentType: JSON_UTF8,
    write: "idempotent",
    nodeOnly: true,
    params: { channel: { in: "body", type: "string", required: true }, ts: { in: "body", type: "string", required: true, description: "ts of the message" } },
  },
  {
    name: "add_reaction",
    title: "Add reaction",
    description: "Add an emoji reaction to a message (a repeat answers already_reacted)",
    method: "POST",
    path: "/reactions.add",
    contentType: JSON_UTF8,
    write: "idempotent",
    params: {
      channel: { in: "body", type: "string", required: true },
      timestamp: { in: "body", type: "string", required: true, description: "Message ts" },
      name: { in: "body", type: "string", required: true, description: "Emoji name without colons, e.g. thumbsup" },
    },
  },
  {
    name: "remove_reaction",
    title: "Remove reaction",
    description: "Remove the token's emoji reaction from a message",
    method: "POST",
    path: "/reactions.remove",
    contentType: JSON_UTF8,
    write: "idempotent",
    params: {
      channel: { in: "body", type: "string", required: true },
      timestamp: { in: "body", type: "string", required: true, description: "Message ts" },
      name: { in: "body", type: "string", required: true, description: "Emoji name without colons" },
    },
  },
];

// Exported for the generated contract tests; the plugin itself is `pluginDefinition` below.
export const restDefinition = defineRestPlugin({
  name: "slack",
  version: "0.1.0",
  description: "Slack Web API: conversations, history and threads, post/edit messages (opt-in for agents), reactions, users, file uploads and message search",
  apiName: "Slack Web API",
  baseUrl: "https://slack.com/api",
  auth: { type: "bearer", env: "SLACK_BOT_TOKEN" },
  extraEnv: [USER_TOKEN_ENV, UPLOAD_DIR_ENV, SEND_OPT_IN_ENV],
  limits: { timeout_ms: 180000 },
  errors: SLACK_ERRORS,
  apiRequest: { examplePath: "/team.info" },
  operations: [...readOperations, ...writeOperations],
});

// The hand-written operations go before api_request, which stays last.
const apiRequestOperations = restDefinition.operations.filter((operation) => operation.name === "api_request").map(restrictApiRequestForTools);
export const pluginDefinition = {
  ...restDefinition,
  operations: [...restDefinition.operations.filter((operation) => operation.name !== "api_request"), uploadFileOperation, searchMessagesOperation, ...apiRequestOperations],
};
