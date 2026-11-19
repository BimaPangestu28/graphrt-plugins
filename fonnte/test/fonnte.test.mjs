import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const SEND_ALLOWED = { FONNTE_TOOL_ALLOW_SEND: "1", FONNTE_TOOL_RECIPIENT_ALLOWLIST: "+62812*" };
const SENT = [{ body: { status: true, id: ["1"], process: "pending" } }];

async function runFonnte(operationName, args, { environment = {}, source = "tool", responses = SENT } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { FONNTE_TOKEN: "fonnte-token-1", ...environment }, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("the token is sent as the raw Authorization header", async () => {
  const { calls } = await runFonnte("get_device", {}, { responses: [{ body: { status: true } }] });
  assert.equal(calls[0].headers.authorization, "fonnte-token-1");
});

test("send_message as a tool needs the opt-in and a matching allowlist", async () => {
  const noAllowlist = await runFonnte("send_message", { target: "+6281234567890", message: "Hi" }, { environment: { FONNTE_TOOL_ALLOW_SEND: "1" } });
  assert.equal(noAllowlist.error.kind, "permission_denied");
  assert.match(noAllowlist.error.message, /FONNTE_TOOL_RECIPIENT_ALLOWLIST/);
  const outside = await runFonnte("send_message", { target: "+6285700000000", message: "Hi" }, { environment: SEND_ALLOWED });
  assert.equal(outside.error.kind, "permission_denied");
  assert.equal(noAllowlist.calls.length + outside.calls.length, 0);
  const allowed = await runFonnte("send_message", { target: "+62 812-3456-7890", message: "Hi" }, { environment: SEND_ALLOWED });
  if (allowed.error) throw allowed.error;
  assert.equal(allowed.calls[0].formData.get("target"), "6281234567890");
  assert.equal(allowed.calls[0].formData.get("countryCode"), "0");
});

test("national numbers and comma lists are refused, so Fonnte never guesses the country or fans out", async () => {
  for (const badTarget of ["081234567890", "6281234567890", "+6281234567890,+6285700000000", "120363000000000000@g.us"]) {
    const { error, calls } = await runFonnte("send_message", { target: badTarget, message: "Hi" }, { source: "node" });
    assert.equal(error?.kind, "invalid_input", badTarget);
    assert.equal(calls.length, 0);
  }
  const validate = await runFonnte("validate_numbers", { numbers: ["+6281234567890", "0812"] }, { responses: [{ body: { status: true } }] });
  assert.equal(validate.error.kind, "invalid_input");
  assert.match(validate.error.message, /numbers\[1\]/);
});

test("group sends, deletes, disconnect and group refresh are node only", async () => {
  const toolNames = buildManifest(pluginDefinition).tools.map((tool) => tool.name);
  assert.deepEqual(toolNames.sort(), ["get_device", "list_whatsapp_groups", "send_message", "validate_numbers"]);
  const badGroup = await runFonnte("send_group_message", { group_id: "6281234567890", message: "Hi" }, { source: "node" });
  assert.equal(badGroup.error.kind, "invalid_input");
});

test("status:false bodies become errors; token invalid is auth_error", async () => {
  const { error } = await runFonnte("get_device", {}, { responses: [{ body: { reason: "token invalid", status: false } }] });
  assert.equal(error.kind, "auth_error");
  const detailOnly = await runFonnte("list_whatsapp_groups", {}, { responses: [{ body: { detail: "you have no whatsapp group yet", status: false } }] });
  assert.match(detailOnly.error.message, /no whatsapp group yet/);
});

test("a failed send is not retried and says how to check", async () => {
  const { error, calls } = await runFonnte("send_message", { target: "+6281234567890", message: "Hi" }, { source: "node", responses: [{ status: 502, body: {} }, ...SENT] });
  assert.equal(calls.length, 1);
  assert.equal(error.retryable, false);
  assert.match(error.message, /message report/);
});

test("a capitalised Status:false body is an error too", async () => {
  const { error } = await runFonnte("get_device", {}, { responses: [{ body: { Status: false, reason: "token invalid" } }] });
  assert.equal(error?.kind, "auth_error");
  const send = await runFonnte("send_message", { target: "+6281234567890", message: "Hi" }, { source: "node", responses: [{ body: { Status: false, reason: "target invalid" } }] });
  assert.equal(send.error?.kind, "invalid_input");
  assert.match(send.error.message, /target invalid/);
});

test("sends need message or file_url", async () => {
  for (const operationName of ["send_message", "send_group_message"]) {
    const args = operationName === "send_message" ? { target: "+6281234567890" } : { group_id: "120363000000000000@g.us" };
    const { error, calls } = await runFonnte(operationName, args, { source: "node" });
    assert.equal(error?.kind, "invalid_input", operationName);
    assert.match(error.message, /message.*file_url/);
    assert.equal(calls.length, 0);
  }
  const fileOnly = await runFonnte("send_message", { target: "+6281234567890", file_url: "https://example.com/a.pdf" }, { source: "node" });
  if (fileOnly.error) throw fileOnly.error;
});

test("a full-number allowlist entry matches exactly; broad prefixes are refused", async () => {
  const longer = await runFonnte("send_message", { target: "+6281234567890", message: "Hi" }, { environment: { FONNTE_TOOL_ALLOW_SEND: "1", FONNTE_TOOL_RECIPIENT_ALLOWLIST: "+628123456789" } });
  assert.equal(longer.error.kind, "permission_denied");
  const broad = await runFonnte("send_message", { target: "+6281234567890", message: "Hi" }, { environment: { FONNTE_TOOL_ALLOW_SEND: "1", FONNTE_TOOL_RECIPIENT_ALLOWLIST: "+62*" } });
  assert.match(broad.error.message, /too broad/);
});
