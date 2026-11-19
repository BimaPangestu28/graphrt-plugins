import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.line.me";
const USER_ID = `U${"a".repeat(32)}`;
const GROUP_ID = `C${"b".repeat(32)}`;
const TEXT = [{ type: "text", text: "Hello" }];

describeRestPluginContract(pluginDefinition, {
  // The allowlist lets the generated opt-in test's tool push through (tools need both).
  environment: { LINE_TOOL_RECIPIENT_ALLOWLIST: USER_ID },
  operations: {
    get_bot_info: {
      args: {},
      request: { method: "GET", url: `${API}/v2/bot/info`, query: "absent" },
      response: { body: { userId: USER_ID, basicId: "@216ru...", displayName: "Shop", chatMode: "bot" } },
      expect: { data: { userId: USER_ID, basicId: "@216ru...", displayName: "Shop", chatMode: "bot" } },
    },
    get_profile: {
      args: { user_id: USER_ID },
      request: { method: "GET", url: `${API}/v2/bot/profile/${USER_ID}`, query: "absent" },
    },
    list_followers: {
      args: { limit: 2, cursor: "yANU9IA" },
      request: { method: "GET", url: `${API}/v2/bot/followers/ids`, query: { start: "yANU9IA", limit: "2" } },
      response: { body: { userIds: [USER_ID], next: "zBNV0JB" } },
      expect: { data: [USER_ID] },
    },
    get_group_summary: {
      args: { group_id: GROUP_ID },
      request: { method: "GET", url: `${API}/v2/bot/group/${GROUP_ID}/summary`, query: "absent" },
    },
    get_group_member_count: {
      args: { group_id: GROUP_ID },
      request: { method: "GET", url: `${API}/v2/bot/group/${GROUP_ID}/members/count`, query: "absent" },
    },
    get_group_member_profile: {
      args: { group_id: GROUP_ID, user_id: USER_ID },
      request: { method: "GET", url: `${API}/v2/bot/group/${GROUP_ID}/member/${USER_ID}`, query: "absent" },
    },
    get_quota: {
      args: {},
      request: { method: "GET", url: `${API}/v2/bot/message/quota`, query: "absent" },
      response: { body: { type: "limited", value: 200 } },
      expect: { data: { type: "limited", value: 200 } },
    },
    get_quota_consumption: {
      args: {},
      request: { method: "GET", url: `${API}/v2/bot/message/quota/consumption`, query: "absent" },
    },
    get_push_message_count: {
      args: { date: "20261119" },
      request: { method: "GET", url: `${API}/v2/bot/message/delivery/push`, query: { date: "20261119" } },
    },
    validate_push_messages: {
      args: { messages: TEXT },
      request: { method: "POST", url: `${API}/v2/bot/message/validate/push`, query: "absent", json: { messages: TEXT } },
    },
    push_message: {
      args: { to: USER_ID, messages: TEXT, notification_disabled: true },
      request: { method: "POST", url: `${API}/v2/bot/message/push`, query: "absent", json: { to: USER_ID, messages: TEXT, notificationDisabled: true } },
      response: { body: { sentMessages: [{ id: "461230966842064897", quoteToken: "IStG5h1Tz7b..." }] } },
      expect: { data: { sentMessages: [{ id: "461230966842064897", quoteToken: "IStG5h1Tz7b..." }] } },
    },
    reply_message: {
      args: { reply_token: "nHuyWiB7yP5Zw52FIkcQobQuGDXCTA", messages: TEXT },
      request: { method: "POST", url: `${API}/v2/bot/message/reply`, query: "absent", json: { replyToken: "nHuyWiB7yP5Zw52FIkcQobQuGDXCTA", messages: TEXT } },
    },
    multicast_message: {
      args: { to: [USER_ID, `U${"c".repeat(32)}`], messages: TEXT },
      request: { method: "POST", url: `${API}/v2/bot/message/multicast`, query: "absent", json: { to: [USER_ID, `U${"c".repeat(32)}`], messages: TEXT } },
    },
    broadcast_message: {
      args: { messages: TEXT },
      request: { method: "POST", url: `${API}/v2/bot/message/broadcast`, query: "absent", json: { messages: TEXT } },
    },
    show_loading_animation: {
      args: { chat_id: USER_ID, loading_seconds: 10 },
      request: { method: "POST", url: `${API}/v2/bot/chat/loading/start`, query: "absent", json: { chatId: USER_ID, loadingSeconds: 10 } },
      response: { status: 202, body: {} },
    },
  },
});
