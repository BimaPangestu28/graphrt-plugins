import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const USER_ID = `U${"a".repeat(32)}`;
const OTHER_USER_ID = `U${"d".repeat(32)}`;
const TEXT = [{ type: "text", text: "Hi" }];
const SENT = [{ body: { sentMessages: [{ id: "1" }] } }];

async function runLine(operationName, args, { environment = {}, source = "tool", responses = SENT } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { LINE_CHANNEL_ACCESS_TOKEN: "line-token-1", ...environment }, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("push_message as a tool needs the opt-in and the target id in the allowlist", async () => {
  const noAllowlist = await runLine("push_message", { to: USER_ID, messages: TEXT }, { environment: { LINE_TOOL_ALLOW_SEND: "1" } });
  assert.equal(noAllowlist.error.kind, "permission_denied");
  assert.match(noAllowlist.error.message, /LINE_TOOL_RECIPIENT_ALLOWLIST/);
  const outside = await runLine("push_message", { to: OTHER_USER_ID, messages: TEXT }, { environment: { LINE_TOOL_ALLOW_SEND: "1", LINE_TOOL_RECIPIENT_ALLOWLIST: USER_ID } });
  assert.equal(outside.error.kind, "permission_denied");
  assert.equal(noAllowlist.calls.length + outside.calls.length, 0);
  const allowed = await runLine("push_message", { to: USER_ID, messages: TEXT }, { environment: { LINE_TOOL_ALLOW_SEND: "1", LINE_TOOL_RECIPIENT_ALLOWLIST: `${OTHER_USER_ID}, ${USER_ID}` } });
  if (allowed.error) throw allowed.error;
  assert.equal(allowed.calls.length, 1);
});

test("push targets must be LINE ids, for nodes too", async () => {
  for (const badTarget of ["@shop", "U123", `X${"a".repeat(32)}`, `U${"A".repeat(32)}`]) {
    const { error, calls } = await runLine("push_message", { to: badTarget, messages: TEXT }, { source: "node" });
    assert.equal(error?.kind, "invalid_input", badTarget);
    assert.equal(calls.length, 0);
  }
  const multicast = await runLine("multicast_message", { to: [USER_ID, `C${"b".repeat(32)}`], messages: TEXT }, { source: "node" });
  assert.equal(multicast.error.kind, "invalid_input");
  assert.match(multicast.error.message, /to\[1\]/);
});

test("push sends an X-Line-Retry-Key and reuses it on a retry; reply sends none", async () => {
  const push = await runLine("push_message", { to: USER_ID, messages: TEXT }, { source: "node", responses: [{ status: 500, body: { message: "boom" } }, ...SENT] });
  if (push.error) throw push.error;
  const retryKey = push.calls[0].headers["x-line-retry-key"];
  assert.match(retryKey, /^[0-9a-f-]{36}$/);
  assert.equal(push.calls[1].headers["x-line-retry-key"], retryKey);
  const reply = await runLine("reply_message", { reply_token: "token-1", messages: TEXT }, { source: "node" });
  assert.equal(reply.calls[0].headers["x-line-retry-key"], undefined);
});

test("reply_message needs only the opt-in (the token picks the chat)", async () => {
  const refused = await runLine("reply_message", { reply_token: "token-1", messages: TEXT });
  assert.equal(refused.error.kind, "permission_denied");
  const allowed = await runLine("reply_message", { reply_token: "token-1", messages: TEXT }, { environment: { LINE_TOOL_ALLOW_SEND: "1" } });
  if (allowed.error) throw allowed.error;
});

test("multicast and broadcast are node only; more than 5 messages are refused", async () => {
  const toolNames = buildManifest(pluginDefinition).tools.map((tool) => tool.name);
  assert.equal(toolNames.includes("multicast_message"), false);
  assert.equal(toolNames.includes("broadcast_message"), false);
  const tooMany = await runLine("push_message", { to: USER_ID, messages: Array.from({ length: 6 }, () => TEXT[0]) }, { source: "node" });
  assert.equal(tooMany.error.kind, "invalid_input");
});

test("LINE's {message, details} errors keep the message", async () => {
  const { error } = await runLine("get_profile", { user_id: USER_ID }, { responses: [{ status: 401, body: { message: "Authentication failed due to the following reason: invalid token." } }] });
  assert.equal(error.kind, "auth_error");
  assert.match(error.message, /invalid token/);
});

test("push: 500, retry with the same key, 409 already accepted -> success with already_accepted", async () => {
  const conflict = { status: 409, headers: { "x-line-accepted-request-id": "req-original-1" }, body: { message: "The retry key is already accepted" } };
  const { output, error, calls } = await runLine("push_message", { to: USER_ID, messages: TEXT }, { source: "node", responses: [{ status: 500, body: { message: "boom" } }, conflict] });
  if (error) throw error;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers["x-line-retry-key"], calls[0].headers["x-line-retry-key"]);
  assert.equal(output.data.already_accepted, true);
  assert.equal(output.data.accepted_request_id, "req-original-1");
  assert.match(output.data.note, /already sent; do not resend/);
});

test("broadcast and multicast treat a 409 with their retry key as accepted too", async () => {
  const conflict = [{ status: 409, headers: { "x-line-accepted-request-id": "req-2" }, body: { message: "The retry key is already accepted" } }];
  const broadcast = await runLine("broadcast_message", { messages: TEXT }, { source: "node", responses: conflict });
  if (broadcast.error) throw broadcast.error;
  assert.equal(broadcast.output.data.already_accepted, true);
});

test("a 409 on a request without a retry key stays an error", async () => {
  const { error } = await runLine("reply_message", { reply_token: "token-1", messages: TEXT }, { source: "node", responses: [{ status: 409, body: { message: "conflict" } }] });
  assert.equal(error?.kind, "api_error");
});

test("allowlist entries for LINE ids match exactly", async () => {
  const { error } = await runLine("push_message", { to: USER_ID, messages: TEXT }, { environment: { LINE_TOOL_ALLOW_SEND: "1", LINE_TOOL_RECIPIENT_ALLOWLIST: USER_ID.slice(0, -1) } });
  assert.equal(error?.kind, "permission_denied");
});
