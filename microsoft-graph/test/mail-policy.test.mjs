import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { clearOAuthTokenCache } from "../lib/shared/rest-oauth.mjs";
import { pluginDefinition } from "../definition.mjs";
import { isRecipientAllowed, normalizeAddresses, parseRecipientAllowlist } from "../lib/recipient-policy.mjs";

const NODE_TOKEN = { access_token: "graph-node-token-1" };
const SEND_ALLOWED = { MICROSOFT_GRAPH_TOOL_ALLOW_SEND: "1" };

async function runGraph(operationName, args, { environment = {}, source = "tool", responses = [{ status: 202 }] } = {}) {
  // Tool calls fetch an OAuth token first (cleared between tests so each test sees its own token request).
  clearOAuthTokenCache();
  const tokenResponses = source === "tool" ? [{ body: { access_token: "graph-access-1", expires_in: 3600 } }] : [];
  const recordingFetch = createRecordingFetch([...tokenResponses, ...responses]);
  const run = createOperationRunner(pluginDefinition, { MICROSOFT_CLIENT_ID: "c", MICROSOFT_CLIENT_SECRET: "client-secret-1", MICROSOFT_REFRESH_TOKEN: "refresh-1", ...environment }, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, { ...args, ...(source === "node" ? NODE_TOKEN : {}) }, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls.filter((call) => call.url.startsWith("https://graph.microsoft.com")) };
}

const mail = { to: ["ada@example.com"], bcc: ["boss@other.example"], subject: "Hi", body: "Hello" };

test("send_mail as a tool: the allowlist covers to, cc and bcc", async () => {
  const environment = { ...SEND_ALLOWED, MICROSOFT_GRAPH_TOOL_RECIPIENT_ALLOWLIST: "@example.com" };
  const refused = await runGraph("send_mail", mail, { environment });
  assert.equal(refused.error.kind, "permission_denied");
  assert.match(refused.error.message, /boss@other\.example/);
  assert.equal(refused.calls.length, 0);
  const allowed = await runGraph("send_mail", { ...mail, bcc: ["carol@EXAMPLE.com"] }, { environment: { ...environment, MICROSOFT_GRAPH_TOOL_RECIPIENT_ALLOWLIST: "@example.com, dave@x.example" } });
  if (allowed.error) throw allowed.error;
  assert.deepEqual(allowed.calls[0].json.message.bccRecipients, [{ emailAddress: { address: "carol@EXAMPLE.com" } }]);
});

test("send_mail: nodes ignore the allowlist; the opt-in still gates tools", async () => {
  const node = await runGraph("send_mail", mail, { source: "node", environment: { MICROSOFT_GRAPH_TOOL_RECIPIENT_ALLOWLIST: "@example.com" } });
  if (node.error) throw node.error;
  assert.equal(node.calls.length, 1);
  const noOptIn = await runGraph("send_mail", mail);
  assert.equal(noOptIn.error.kind, "permission_denied");
  assert.match(noOptIn.error.message, /MICROSOFT_GRAPH_TOOL_ALLOW_SEND/);
});

test("addresses with display names, line breaks or separators are refused before any request", async () => {
  for (const badAddress of ["Ada <ada@example.com>", "ada@example.com\r\nBcc: x@y.z", "a@b.com,c@d.com", "not-an-address", "ada@localhost"]) {
    const { error, calls } = await runGraph("send_mail", { ...mail, to: [badAddress] }, { source: "node" });
    assert.equal(error?.kind, "invalid_input", badAddress);
    assert.equal(calls.length, 0);
  }
});

test("addresses with control characters (NUL, DEL, other C0) are refused", () => {
  for (const controlCharacter of ["\u0000", "\u0001", "\u001f", "\u007f"]) {
    assert.throws(() => normalizeAddresses([`a${controlCharacter}b@example.com`], "to"), (error) => error.kind === "invalid_input", JSON.stringify(controlCharacter));
  }
});

test("send_mail requires to, subject and body; the schema shows simple fields", async () => {
  const sendMailTool = buildManifest(pluginDefinition).tools.find((tool) => tool.name === "send_mail");
  assert.deepEqual(sendMailTool.parameters.required, ["to", "subject", "body"]);
  assert.equal("message" in sendMailTool.parameters.properties, false);
  const { error } = await runGraph("send_mail", { to: ["ada@example.com"], subject: "x" }, { source: "node" });
  assert.equal(error.kind, "invalid_input");
});

test("create_draft is a tool without the opt-in (nothing is sent)", async () => {
  const { error, calls } = await runGraph("create_draft", { to: ["anyone@else.example"], subject: "Draft" }, { responses: [{ status: 201, body: { id: "d1" } }], environment: { MICROSOFT_GRAPH_TOOL_RECIPIENT_ALLOWLIST: "@example.com" } });
  if (error) throw error;
  assert.equal(calls[0].url, "https://graph.microsoft.com/v1.0/me/messages");
});

test("reply_to_message: tools need the opt-in and are refused while an allowlist is set", async () => {
  const args = { message_id: "m1", reply_kind: "reply", comment: "Thanks" };
  const withAllowlist = await runGraph("reply_to_message", args, { environment: { ...SEND_ALLOWED, MICROSOFT_GRAPH_TOOL_RECIPIENT_ALLOWLIST: "@example.com" } });
  assert.equal(withAllowlist.error.kind, "permission_denied");
  assert.equal(withAllowlist.calls.length, 0);
  const allowed = await runGraph("reply_to_message", args, { environment: SEND_ALLOWED });
  if (allowed.error) throw allowed.error;
  assert.equal(allowed.calls.length, 1);
});

test("update_event: tools need the opt-in and are refused while an allowlist is set (attendees get notified)", async () => {
  const args = { event_id: "e1", location: "Room 4" };
  const withAllowlist = await runGraph("update_event", args, { responses: [{ body: { id: "e1" } }], environment: { ...SEND_ALLOWED, MICROSOFT_GRAPH_TOOL_RECIPIENT_ALLOWLIST: "@example.com" } });
  assert.equal(withAllowlist.error?.kind, "permission_denied");
  assert.match(withAllowlist.error.message, /MICROSOFT_GRAPH_TOOL_RECIPIENT_ALLOWLIST/);
  assert.equal(withAllowlist.calls.length, 0);
  const allowed = await runGraph("update_event", args, { responses: [{ body: { id: "e1" } }], environment: SEND_ALLOWED });
  if (allowed.error) throw allowed.error;
  assert.equal(allowed.calls.length, 1);
  const node = await runGraph("update_event", args, { source: "node", responses: [{ body: { id: "e1" } }], environment: { MICROSOFT_GRAPH_TOOL_RECIPIENT_ALLOWLIST: "@example.com" } });
  if (node.error) throw node.error;
});

test("send_draft and deletes are not agent tools", () => {
  const toolNames = buildManifest(pluginDefinition).tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["send_draft", "delete_message", "delete_event"]) assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
});

test("allowlist parsing and matching", () => {
  const entries = parseRecipientAllowlist(" Ada@Example.com ,@example.org,, ");
  assert.deepEqual(entries, ["ada@example.com", "@example.org"]);
  assert.equal(isRecipientAllowed("ADA@example.com", entries), true);
  assert.equal(isRecipientAllowed("bob@example.org", entries), true);
  assert.equal(isRecipientAllowed("bob@sub.example.org", entries), false);
  assert.equal(isRecipientAllowed("bob@example.com", entries), false);
  assert.deepEqual(normalizeAddresses([" ada@example.com "], "to"), ["ada@example.com"]);
});
