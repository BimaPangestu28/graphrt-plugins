import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner, buildManifest } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { clearOAuthTokenCache } from "../lib/shared/rest-oauth.mjs";
import { pluginDefinition } from "../definition.mjs";

const GRAPH = "https://graph.microsoft.com/v1.0";
const CHANNEL = "19:abc@thread.tacv2";
const ENCODED_CHANNEL = "19%3Aabc%40thread.tacv2";
const CHAT = "19:xyz@unq.gbl.spaces";
const ENCODED_CHAT = "19%3Axyz%40unq.gbl.spaces";
const page = (items) => ({ body: { value: items, "@odata.nextLink": `${GRAPH}/teams/t1/channels?$skiptoken=abc` } });

describeRestPluginContract(pluginDefinition, {
  operations: {
    get_me: { args: {}, request: { method: "GET", url: `${GRAPH}/me`, query: "absent" }, response: { body: { id: "u1", displayName: "Ada" } } },
    list_joined_teams: { args: {}, request: { method: "GET", url: `${GRAPH}/me/joinedTeams`, query: "absent" }, response: { body: { value: [{ id: "t1" }] } }, expect: { data: [{ id: "t1" }] } },
    get_team: { args: { team_id: "t1" }, request: { method: "GET", url: `${GRAPH}/teams/t1`, query: "absent" } },
    list_team_members: { args: { team_id: "t1" }, request: { method: "GET", url: `${GRAPH}/teams/t1/members`, query: "absent" }, response: { body: { value: [] } } },
    list_channels: {
      args: { team_id: "t1", select: ["id", "displayName"], filter: "membershipType eq 'standard'" },
      request: { method: "GET", url: `${GRAPH}/teams/t1/channels`, query: { $select: "id,displayName", $filter: "membershipType eq 'standard'" } },
      response: page([{ id: CHANNEL }]),
      expect: { data: [{ id: CHANNEL }] },
    },
    get_channel: { args: { team_id: "t1", channel_id: CHANNEL }, request: { method: "GET", url: `${GRAPH}/teams/t1/channels/${ENCODED_CHANNEL}`, query: "absent" } },
    list_channel_members: { args: { team_id: "t1", channel_id: CHANNEL }, request: { method: "GET", url: `${GRAPH}/teams/t1/channels/${ENCODED_CHANNEL}/members`, query: "absent" }, response: { body: { value: [] } } },
    list_channel_messages: {
      args: { team_id: "t1", channel_id: CHANNEL, expand_replies: "replies", limit: 10 },
      request: { method: "GET", url: `${GRAPH}/teams/t1/channels/${ENCODED_CHANNEL}/messages`, query: { $expand: "replies", $top: "10" } },
      response: { body: { value: [{ id: "m1" }] } },
      expect: { data: [{ id: "m1" }] },
    },
    get_channel_message: { args: { team_id: "t1", channel_id: CHANNEL, message_id: "m1" }, request: { method: "GET", url: `${GRAPH}/teams/t1/channels/${ENCODED_CHANNEL}/messages/m1`, query: "absent" } },
    list_message_replies: { args: { team_id: "t1", channel_id: CHANNEL, message_id: "m1" }, request: { method: "GET", url: `${GRAPH}/teams/t1/channels/${ENCODED_CHANNEL}/messages/m1/replies`, query: { $top: "20" } }, response: { body: { value: [] } } },
    send_channel_message: {
      args: { team_id: "t1", channel_id: CHANNEL, content: "Release is out", subject: "Release" },
      request: { method: "POST", url: `${GRAPH}/teams/t1/channels/${ENCODED_CHANNEL}/messages`, query: "absent", json: { body: { content: "Release is out", contentType: "text" }, subject: "Release" } },
      response: { status: 201, body: { id: "m2" } },
    },
    reply_to_channel_message: {
      args: { team_id: "t1", channel_id: CHANNEL, message_id: "m1", content: "<b>Done</b>", content_type: "html" },
      request: { method: "POST", url: `${GRAPH}/teams/t1/channels/${ENCODED_CHANNEL}/messages/m1/replies`, query: "absent", json: { body: { content: "<b>Done</b>", contentType: "html" } } },
    },
    list_chats: {
      args: { expand_members: "members", order_by: "lastMessagePreview/createdDateTime desc" },
      request: { method: "GET", url: `${GRAPH}/me/chats`, query: { $expand: "members", $orderby: "lastMessagePreview/createdDateTime desc", $top: "20" } },
      response: { body: { value: [{ id: CHAT }] } },
    },
    get_chat: { args: { chat_id: CHAT }, request: { method: "GET", url: `${GRAPH}/chats/${ENCODED_CHAT}`, query: "absent" } },
    list_chat_messages: { args: { chat_id: CHAT, order_by: "createdDateTime desc" }, request: { method: "GET", url: `${GRAPH}/chats/${ENCODED_CHAT}/messages`, query: { $orderby: "createdDateTime desc", $top: "20" } }, response: { body: { value: [] } } },
    send_chat_message: {
      args: { chat_id: CHAT, content: "On my way" },
      request: { method: "POST", url: `${GRAPH}/chats/${ENCODED_CHAT}/messages`, query: "absent", json: { body: { content: "On my way", contentType: "text" } } },
    },
  },
});

const CREDENTIALS = { MICROSOFT_CLIENT_ID: "client-1", MICROSOFT_CLIENT_SECRET: "client-secret-1", MICROSOFT_REFRESH_TOKEN: "refresh-token-1" };

function createTokenAwareFetch() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), body: typeof init.body === "string" ? init.body : undefined, headers: init.headers ?? {} });
    const body = String(url).includes("login.microsoftonline.com") ? { access_token: "graph-access-1", expires_in: 3600, refresh_token: "refresh-token-2" } : { id: "u1" };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

test("MICROSOFT_TENANT_ID selects the tenant's token URL; the refresh grant asks for .default + offline_access", async () => {
  clearOAuthTokenCache();
  const { fetchImpl, calls } = createTokenAwareFetch();
  const run = createOperationRunner(pluginDefinition, { ...CREDENTIALS, MICROSOFT_TENANT_ID: "contoso.onmicrosoft.com" }, { fetchImpl });
  await run("get_me", {}, { source: "node" });
  assert.equal(calls[0].url, "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token");
  const tokenForm = Object.fromEntries(new URLSearchParams(calls[0].body));
  assert.deepEqual(tokenForm, { grant_type: "refresh_token", refresh_token: "refresh-token-1", client_id: "client-1", client_secret: "client-secret-1", scope: "https://graph.microsoft.com/.default offline_access" });
  assert.equal(calls[1].url, `${GRAPH}/me`);
  assert.equal(calls[1].headers.authorization, "Bearer graph-access-1");
});

test("without MICROSOFT_TENANT_ID the common endpoint is used; malformed tenants are refused", async () => {
  clearOAuthTokenCache();
  const { fetchImpl, calls } = createTokenAwareFetch();
  await createOperationRunner(pluginDefinition, CREDENTIALS, { fetchImpl })("get_me", {}, { source: "node" });
  assert.equal(calls[0].url, "https://login.microsoftonline.com/common/oauth2/v2.0/token");
  for (const badTenant of ["evil.example/x", "a b", "../x", "x?y"]) {
    const run = createOperationRunner(pluginDefinition, { ...CREDENTIALS, MICROSOFT_TENANT_ID: badTenant }, { fetchImpl });
    await assert.rejects(run("get_me", {}, { source: "node" }), (error) => error.kind === "invalid_input", badTenant);
  }
});

test("manifest lists the OAuth env, the tenant and the send opt-in", () => {
  assert.deepEqual(buildManifest(pluginDefinition).permissions.env, ["MICROSOFT_CLIENT_SECRET", "MICROSOFT_CLIENT_ID", "MICROSOFT_REFRESH_TOKEN", "MICROSOFT_TENANT_ID", "MICROSOFT_TEAMS_TOOL_ALLOW_SEND", "MICROSOFT_TEAMS_TOOL_TOKEN_SOURCE"]);
});

test("Graph errors map by error.code", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { code: "Forbidden", message: "Missing scope permissions on the request." } }), { status: 403, headers: { "content-type": "application/json" } });
  const run = createOperationRunner(pluginDefinition, CREDENTIALS, { fetchImpl });
  await assert.rejects(run("list_chats", { access_token: "node-token-1" }, { source: "node" }), (error) => error.kind === "permission_denied" && /Missing scope permissions on the request\. \(Forbidden\)/.test(error.message));
});
