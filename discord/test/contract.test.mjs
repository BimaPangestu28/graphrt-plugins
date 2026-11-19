import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://discord.com/api/v10";
const NO_PINGS = { parse: [] };

describeRestPluginContract(pluginDefinition, {
  operations: {
    get_current_user: { args: {}, request: { method: "GET", url: `${API}/users/@me`, query: "absent" }, response: { body: { id: "1", username: "bot" } }, expect: { data: { id: "1", username: "bot" } } },
    list_my_guilds: {
      args: { with_counts: true, limit: 2 },
      request: { method: "GET", url: `${API}/users/@me/guilds`, query: { with_counts: "true", limit: "2" } },
      response: { body: [{ id: "10" }, { id: "11" }] },
      expect: { data: [{ id: "10" }, { id: "11" }] },
    },
    get_guild: { args: { guild_id: "10" }, request: { method: "GET", url: `${API}/guilds/10`, query: "absent" } },
    list_guild_channels: { args: { guild_id: "10" }, request: { method: "GET", url: `${API}/guilds/10/channels`, query: "absent" }, response: { body: [{ id: "20", type: 0 }] } },
    list_guild_members: {
      args: { guild_id: "10", cursor: "500" },
      request: { method: "GET", url: `${API}/guilds/10/members`, query: { after: "500", limit: "100" } },
      response: { body: [{ user: { id: "501" } }] },
    },
    search_guild_members: { args: { guild_id: "10", query: "ada" }, request: { method: "GET", url: `${API}/guilds/10/members/search`, query: { query: "ada", limit: "20" } } },
    get_guild_member: { args: { guild_id: "10", user_id: "501" }, request: { method: "GET", url: `${API}/guilds/10/members/501`, query: "absent" } },
    get_channel: { args: { channel_id: "20" }, request: { method: "GET", url: `${API}/channels/20`, query: "absent" } },
    list_messages: {
      args: { channel_id: "20", limit: 10 },
      request: { method: "GET", url: `${API}/channels/20/messages`, query: { limit: "10" } },
      response: { body: [{ id: "300", content: "hi" }] },
      expect: { data: [{ id: "300", content: "hi" }] },
    },
    get_message: { args: { channel_id: "20", message_id: "300" }, request: { method: "GET", url: `${API}/channels/20/messages/300`, query: "absent" } },
    list_reactions: {
      args: { channel_id: "20", message_id: "300", emoji: "👍" },
      request: { method: "GET", url: `${API}/channels/20/messages/300/reactions/%F0%9F%91%8D`, query: { limit: "100" } },
      response: { body: [{ id: "501" }] },
    },
    list_active_threads: { args: { guild_id: "10" }, request: { method: "GET", url: `${API}/guilds/10/threads/active`, query: "absent" }, response: { body: { threads: [], members: [] } } },
    list_public_archived_threads: {
      args: { channel_id: "20", before: "2026-11-01T00:00:00Z", limit: 25 },
      request: { method: "GET", url: `${API}/channels/20/threads/archived/public`, query: { before: "2026-11-01T00:00:00Z", limit: "25" } },
      response: { body: { threads: [], has_more: false } },
    },
    send_message: {
      args: { channel_id: "20", content: "Build finished", reply_to: "300" },
      request: { method: "POST", url: `${API}/channels/20/messages`, query: "absent", json: { content: "Build finished", allowed_mentions: NO_PINGS, message_reference: { message_id: "300" } } },
      response: { body: { id: "301" } },
    },
    edit_message: {
      args: { channel_id: "20", message_id: "301", content: "Build finished (green)" },
      request: { method: "PATCH", url: `${API}/channels/20/messages/301`, query: "absent", json: { content: "Build finished (green)" } },
    },
    delete_message: { args: { channel_id: "20", message_id: "301" }, request: { method: "DELETE", url: `${API}/channels/20/messages/301`, query: "absent", body: "absent" }, response: { status: 204 } },
    add_reaction: {
      args: { channel_id: "20", message_id: "301", emoji: "party:123456" },
      request: { method: "PUT", url: `${API}/channels/20/messages/301/reactions/party%3A123456/@me`, query: "absent", body: "absent" },
      response: { status: 204 },
    },
    remove_own_reaction: {
      args: { channel_id: "20", message_id: "301", emoji: "👍" },
      request: { method: "DELETE", url: `${API}/channels/20/messages/301/reactions/%F0%9F%91%8D/@me`, query: "absent", body: "absent" },
      response: { status: 204 },
    },
    start_thread_from_message: {
      args: { channel_id: "20", message_id: "301", name: "Release notes", auto_archive_duration: 1440 },
      request: { method: "POST", url: `${API}/channels/20/messages/301/threads`, query: "absent", json: { name: "Release notes", auto_archive_duration: 1440 } },
    },
    start_thread: {
      args: { channel_id: "20", name: "Incident 42", thread_type: 12 },
      request: { method: "POST", url: `${API}/channels/20/threads`, query: "absent", json: { name: "Incident 42", type: 12 } },
    },
  },
});

async function runDiscord(operationName, args, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { DISCORD_BOT_TOKEN: "discord-test-token-1" }, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source: "node" }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("the bot token is sent as `Bot <token>` with Discord's User-Agent", async () => {
  const { calls } = await runDiscord("get_current_user", {}, [{ body: { id: "1" } }]);
  assert.equal(calls[0].headers.authorization, "Bot discord-test-token-1");
  assert.match(calls[0].headers["user-agent"], /^DiscordBot \(https:\/\/github\.com\/.+, 0\.1\.0\)$/);
});

test("list_messages pages backwards with before=<oldest id>", async () => {
  const { output } = await runDiscord("list_messages", { channel_id: "20", limit: 2 }, [{ body: [{ id: "305" }, { id: "304" }] }]);
  assert.equal(output.next_cursor, "304");
  const { calls } = await runDiscord("list_messages", { channel_id: "20", limit: 2, cursor: "304" }, [{ body: [] }]);
  assert.deepEqual(calls[0].query, { before: "304", limit: "2" });
});

test("Discord errors keep their JSON code and map to kinds; 429 honours retry_after", async () => {
  const missingAccess = await runDiscord("get_channel", { channel_id: "20" }, [{ status: 403, body: { message: "Missing Access", code: 50001 } }]);
  assert.equal(missingAccess.error.kind, "permission_denied");
  assert.match(missingAccess.error.message, /Missing Access \(50001\)/);
  const unknownMessage = await runDiscord("get_message", { channel_id: "20", message_id: "9" }, [{ status: 404, body: { message: "Unknown Message", code: 10008 } }]);
  assert.equal(unknownMessage.error.kind, "not_found");
  const limited = await runDiscord("get_channel", { channel_id: "20" }, [{ status: 429, body: { message: "You are being rate limited.", retry_after: 0.01, global: false } }, { body: { id: "20" } }]);
  assert.equal(limited.calls.length, 2);
  assert.deepEqual(limited.output.data, { id: "20" });
});
