import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { restDefinition } from "../definition.mjs";

const API = "https://slack.com/api";
const slackOk = (fields) => ({ body: { ok: true, ...fields } });

describeRestPluginContract(restDefinition, {
  operations: {
    auth_test: {
      args: {},
      request: { method: "GET", url: `${API}/auth.test`, query: "absent" },
      response: slackOk({ team_id: "T1", user_id: "U1" }),
      expect: { data: { ok: true, team_id: "T1", user_id: "U1" } },
    },
    list_conversations: {
      args: { types: ["public_channel", "private_channel"], limit: 50 },
      request: { method: "GET", url: `${API}/conversations.list`, query: { types: "public_channel,private_channel", exclude_archived: "true", limit: "50" } },
      response: slackOk({ channels: [{ id: "C1" }], response_metadata: { next_cursor: "dGVhbTpDMDYx" } }),
      expect: { data: [{ id: "C1" }] },
    },
    get_conversation_info: {
      args: { channel: "C1", include_num_members: true },
      request: { method: "GET", url: `${API}/conversations.info`, query: { channel: "C1", include_num_members: "true" } },
      response: slackOk({ channel: { id: "C1", name: "general" } }),
      expect: { data: { id: "C1", name: "general" } },
    },
    get_conversation_history: {
      args: { channel: "C1", oldest: "1731990000.000000", limit: 20 },
      request: { method: "GET", url: `${API}/conversations.history`, query: { channel: "C1", oldest: "1731990000.000000", limit: "20" } },
      response: slackOk({ messages: [{ ts: "1731990001.000100", text: "hi" }], has_more: false, response_metadata: { next_cursor: "" } }),
      expect: { data: [{ ts: "1731990001.000100", text: "hi" }] },
    },
    get_thread_replies: {
      args: { channel: "C1", ts: "1731990001.000100" },
      request: { method: "GET", url: `${API}/conversations.replies`, query: { channel: "C1", ts: "1731990001.000100", limit: "100" } },
      response: slackOk({ messages: [{ ts: "1731990001.000100" }] }),
    },
    get_permalink: {
      args: { channel: "C1", message_ts: "1731990001.000100" },
      request: { method: "GET", url: `${API}/chat.getPermalink`, query: { channel: "C1", message_ts: "1731990001.000100" } },
      response: slackOk({ permalink: "https://acme.slack.com/archives/C1/p1731990001000100" }),
    },
    get_reactions: {
      args: { channel: "C1", timestamp: "1731990001.000100", full: true },
      request: { method: "GET", url: `${API}/reactions.get`, query: { channel: "C1", timestamp: "1731990001.000100", full: "true" } },
      response: slackOk({ message: { reactions: [{ name: "thumbsup", count: 2 }] } }),
      expect: { data: { reactions: [{ name: "thumbsup", count: 2 }] } },
    },
    list_users: {
      args: { limit: 200 },
      request: { method: "GET", url: `${API}/users.list`, query: { limit: "200" } },
      response: slackOk({ members: [{ id: "U1" }] }),
      expect: { data: [{ id: "U1" }] },
    },
    get_user_info: {
      args: { user: "U1" },
      request: { method: "GET", url: `${API}/users.info`, query: { user: "U1" } },
      response: slackOk({ user: { id: "U1", name: "ada" } }),
      expect: { data: { id: "U1", name: "ada" } },
    },
    lookup_user_by_email: {
      args: { email: "ada@example.com" },
      request: { method: "GET", url: `${API}/users.lookupByEmail`, query: { email: "ada@example.com" } },
      response: slackOk({ user: { id: "U1" } }),
    },
    post_message: {
      args: { channel: "C1", text: "Deploy done", thread_ts: "1731990001.000100" },
      request: { method: "POST", url: `${API}/chat.postMessage`, query: "absent", json: { channel: "C1", text: "Deploy done", thread_ts: "1731990001.000100" }, headers: { "content-type": "application/json; charset=utf-8" } },
      response: slackOk({ channel: "C1", ts: "1731990002.000200" }),
    },
    update_message: {
      args: { channel: "C1", ts: "1731990002.000200", text: "Deploy done (v2)" },
      request: { method: "POST", url: `${API}/chat.update`, query: "absent", json: { channel: "C1", ts: "1731990002.000200", text: "Deploy done (v2)" } },
      response: slackOk({ ts: "1731990002.000200" }),
    },
    delete_message: {
      args: { channel: "C1", ts: "1731990002.000200" },
      request: { method: "POST", url: `${API}/chat.delete`, query: "absent", json: { channel: "C1", ts: "1731990002.000200" } },
      response: slackOk({}),
    },
    add_reaction: {
      args: { channel: "C1", timestamp: "1731990002.000200", name: "white_check_mark" },
      request: { method: "POST", url: `${API}/reactions.add`, query: "absent", json: { channel: "C1", timestamp: "1731990002.000200", name: "white_check_mark" } },
      response: slackOk({}),
    },
    remove_reaction: {
      args: { channel: "C1", timestamp: "1731990002.000200", name: "white_check_mark" },
      request: { method: "POST", url: `${API}/reactions.remove`, query: "absent", json: { channel: "C1", timestamp: "1731990002.000200", name: "white_check_mark" } },
      response: slackOk({}),
    },
  },
});
