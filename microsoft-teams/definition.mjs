/**
 * microsoft-teams plugin definition: Microsoft Teams through Microsoft Graph v1.0
 * (https://learn.microsoft.com/en-us/graph/teams-concept-overview). Joined teams, channels, channel messages and
 * replies, chats and chat messages, members. Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Auth is delegated (a signed-in user's refresh token): Graph only allows sending channel and chat messages with
 * delegated permissions (ChannelMessage.Send, ChatMessage.Send); application permissions can send only in
 * migration mode. The token URL depends on MICROSOFT_TENANT_ID (lib/graph-tenant.mjs).
 *
 * Agent policy: every send needs MICROSOFT_TEAMS_TOOL_ALLOW_SEND=1 as a tool.
 */
import { GRAPH_ERRORS } from "./lib/graph-errors.mjs";
import { defineTenantAwarePlugin, TENANT_ENV } from "./lib/graph-tenant.mjs";

const SEND_POLICY = "optIn:MICROSOFT_TEAMS_TOOL_ALLOW_SEND";
const TEAM_ID = { in: "path", type: "string", required: true, description: "Team id (the Microsoft 365 group id)" };
const CHANNEL_ID = { in: "path", type: "string", required: true, description: "Channel id, e.g. 19:abc...@thread.tacv2" };
const MESSAGE_ID = { in: "path", type: "string", required: true, description: "Message id" };
const CHAT_ID = { in: "path", type: "string", required: true, description: "Chat id, e.g. 19:...@unq.gbl.spaces" };
const graphPage = (maxLimit) => ({ dataPath: "value", nextUrlPath: '["@odata.nextLink"]', limitParam: "$top", maxLimit, defaultLimit: Math.min(maxLimit, 20) });
const valueList = { dataPath: "value", nextUrlPath: '["@odata.nextLink"]' };
const odataQuery = {
  select: { in: "query", type: "array", items: { type: "string" }, wireName: "$select", description: "Properties to return" },
  filter: { in: "query", type: "string", wireName: "$filter", description: "OData filter" },
};
const messageBody = {
  content: { in: "body", type: "string", required: true, minLength: 1, wireName: "body.content", description: "Message text, or HTML when content_type is html" },
  content_type: { in: "body", type: "string", enum: ["text", "html"], default: "text", wireName: "body.contentType" },
};
const channelMessagePath = "/teams/{team_id}/channels/{channel_id}/messages";

const teamOperations = [
  { name: "get_me", title: "Signed-in user", description: "The signed-in user (who the refresh token belongs to)", path: "/me" },
  { name: "list_joined_teams", title: "My teams", description: "Teams the signed-in user is a member of", path: "/me/joinedTeams", response: valueList },
  { name: "get_team", title: "Get team", description: "One team's settings", path: "/teams/{team_id}", params: { team_id: TEAM_ID } },
  { name: "list_team_members", title: "Team members", description: "Members of a team", path: "/teams/{team_id}/members", params: { team_id: TEAM_ID }, response: valueList },
  { name: "list_channels", title: "List channels", description: "Channels of a team", path: "/teams/{team_id}/channels", params: { team_id: TEAM_ID, ...odataQuery }, response: valueList },
  { name: "get_channel", title: "Get channel", description: "One channel", path: "/teams/{team_id}/channels/{channel_id}", params: { team_id: TEAM_ID, channel_id: CHANNEL_ID } },
  { name: "list_channel_members", title: "Channel members", description: "Members of a channel", path: "/teams/{team_id}/channels/{channel_id}/members", params: { team_id: TEAM_ID, channel_id: CHANNEL_ID }, response: valueList },
];

const channelMessageOperations = [
  {
    name: "list_channel_messages",
    title: "Channel messages",
    description: "Top-level messages of a channel, newest first (replies with list_message_replies or expand_replies)",
    path: channelMessagePath,
    params: { team_id: TEAM_ID, channel_id: CHANNEL_ID, expand_replies: { in: "query", type: "string", enum: ["replies"], wireName: "$expand", description: "replies: include up to 1000 replies per message" } },
    response: graphPage(50),
  },
  { name: "get_channel_message", title: "Get channel message", description: "One channel message", path: `${channelMessagePath}/{message_id}`, params: { team_id: TEAM_ID, channel_id: CHANNEL_ID, message_id: MESSAGE_ID } },
  {
    name: "list_message_replies",
    title: "Message replies",
    description: "Replies to a channel message",
    path: `${channelMessagePath}/{message_id}/replies`,
    params: { team_id: TEAM_ID, channel_id: CHANNEL_ID, message_id: MESSAGE_ID },
    response: graphPage(50),
  },
  {
    name: "send_channel_message",
    title: "Post to channel",
    description: "Post a new message in a channel",
    method: "POST",
    path: channelMessagePath,
    write: "unsafe",
    toolPolicy: SEND_POLICY,
    checkHint: "list_channel_messages for the channel and look for the content",
    params: { team_id: TEAM_ID, channel_id: CHANNEL_ID, ...messageBody, subject: { in: "body", type: "string", description: "Subject line (channel posts only)" } },
  },
  {
    name: "reply_to_channel_message",
    title: "Reply in channel",
    description: "Reply to a channel message",
    method: "POST",
    path: `${channelMessagePath}/{message_id}/replies`,
    write: "unsafe",
    toolPolicy: SEND_POLICY,
    checkHint: "list_message_replies for the message and look for the content",
    params: { team_id: TEAM_ID, channel_id: CHANNEL_ID, message_id: MESSAGE_ID, ...messageBody },
  },
];

const chatOperations = [
  {
    name: "list_chats",
    title: "My chats",
    description: "1:1, group and meeting chats of the signed-in user",
    path: "/me/chats",
    params: {
      expand_members: { in: "query", type: "string", enum: ["members"], wireName: "$expand", description: "members: include the chat's members" },
      filter: odataQuery.filter,
      order_by: { in: "query", type: "string", enum: ["lastMessagePreview/createdDateTime desc"], wireName: "$orderby" },
    },
    response: graphPage(50),
  },
  { name: "get_chat", title: "Get chat", description: "One chat", path: "/chats/{chat_id}", params: { chat_id: CHAT_ID } },
  {
    name: "list_chat_messages",
    title: "Chat messages",
    description: "Messages of a chat",
    path: "/chats/{chat_id}/messages",
    params: { chat_id: CHAT_ID, order_by: { in: "query", type: "string", enum: ["createdDateTime desc", "lastModifiedDateTime desc"], wireName: "$orderby" }, filter: odataQuery.filter },
    response: graphPage(50),
  },
  {
    name: "send_chat_message",
    title: "Send chat message",
    description: "Send a message in a chat",
    method: "POST",
    path: "/chats/{chat_id}/messages",
    write: "unsafe",
    toolPolicy: SEND_POLICY,
    checkHint: "list_chat_messages for the chat and look for the content",
    params: { chat_id: CHAT_ID, ...messageBody },
  },
];

const buildSpec = (tokenUrl) => ({
  name: "microsoft-teams",
  version: "0.1.0",
  description: "Microsoft Teams via Microsoft Graph: teams, channels, channel messages and replies, chats; agent sends need an opt-in",
  apiName: "Microsoft Graph (Teams)",
  baseUrl: "https://graph.microsoft.com/v1.0",
  toolUserToken: true,
  auth: {
    type: "oauth2",
    grant: "refresh_token",
    tokenUrl,
    clientIdEnv: "MICROSOFT_CLIENT_ID",
    clientSecretEnv: "MICROSOFT_CLIENT_SECRET",
    refreshTokenEnv: "MICROSOFT_REFRESH_TOKEN",
    // The refresh grant gets every delegated permission the user consented to.
    scope: "https://graph.microsoft.com/.default offline_access",
  },
  extraEnv: [TENANT_ENV],
  errors: GRAPH_ERRORS,
  apiRequest: { examplePath: "/me/joinedTeams" },
  operations: [...teamOperations, ...channelMessageOperations, ...chatOperations],
});

export const pluginDefinition = defineTenantAwarePlugin(buildSpec);
