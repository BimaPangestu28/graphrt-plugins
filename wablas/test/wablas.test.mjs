import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const BASE_ENVIRONMENT = { WABLAS_TOKEN: "wablas-token-1", WABLAS_SECRET_KEY: "wablas-secret-1", WABLAS_DOMAIN: "jkt.wablas.com" };
const SEND_ALLOWED = { WABLAS_TOOL_ALLOW_SEND: "1", WABLAS_TOOL_RECIPIENT_ALLOWLIST: "+62812*" };
const QUEUED = [{ body: { status: true, data: { messages: [{ id: "m1" }] } } }];

async function runWablas(operationName, args, { environment = {}, source = "tool", responses = QUEUED } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { ...BASE_ENVIRONMENT, ...environment }, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("get_device_info sends the token as a query parameter and returns data", async () => {
  const { output, error, calls } = await runWablas("get_device_info", {}, { responses: [{ body: { status: true, data: { name: "Toko", quota: 88, status: "connected" } } }] });
  if (error) throw error;
  const callUrl = new URL(calls[0].url);
  assert.equal(`${callUrl.origin}${callUrl.pathname}`, "https://jkt.wablas.com/api/device/info");
  assert.equal(callUrl.searchParams.get("token"), "wablas-token-1");
  assert.deepEqual(output.data, { name: "Toko", quota: 88, status: "connected" });
});

test("get_device_info redacts the token from errors and needs WABLAS_TOKEN", async () => {
  const { error } = await runWablas("get_device_info", {}, { responses: [{ status: 401, body: { status: false, message: "token wablas-token-1 invalid" } }] });
  assert.equal(error.kind, "auth_error");
  assert.equal(error.message.includes("wablas-token-1"), false);
  const missing = await runWablas("get_device_info", {}, { environment: { WABLAS_TOKEN: "" } });
  assert.equal(missing.error.kind, "auth_error");
});

test("WABLAS_DOMAIN must be a wablas.com host", async () => {
  for (const badDomain of ["evil.example", "pati.wablas.com.evil.example", "http://pati.wablas.com", "", "a/b.wablas.com"]) {
    const { error, calls } = await runWablas("list_message_reports", {}, { environment: { WABLAS_DOMAIN: badDomain } });
    assert.equal(error?.kind, "invalid_input", badDomain);
    assert.equal(calls.length, 0);
  }
  const fullUrl = await runWablas("list_message_reports", {}, { environment: { WABLAS_DOMAIN: "https://Pati.wablas.com/" }, responses: [{ body: { status: true, message: [] } }] });
  assert.equal(new URL(fullUrl.calls[0].url).host, "pati.wablas.com");
});

test("sends as tools need the opt-in and a matching allowlist", async () => {
  const noAllowlist = await runWablas("send_message", { phone: "+6281234567890", message: "Hi" }, { environment: { WABLAS_TOOL_ALLOW_SEND: "1" } });
  assert.equal(noAllowlist.error.kind, "permission_denied");
  const outside = await runWablas("send_image", { phone: "+6285700000000", image: "https://example.com/a.png" }, { environment: SEND_ALLOWED });
  assert.equal(outside.error.kind, "permission_denied");
  assert.equal(noAllowlist.calls.length + outside.calls.length, 0);
  const allowed = await runWablas("send_message", { phone: "+6281234567890", message: "Hi" }, { environment: SEND_ALLOWED });
  if (allowed.error) throw allowed.error;
  assert.deepEqual(allowed.calls[0].json, { data: [{ phone: "6281234567890", message: "Hi" }] });
  assert.equal(allowed.calls[0].headers.authorization, "wablas-token-1.wablas-secret-1");
});

test("sends take simple fields with required phone and content; national numbers are refused", async () => {
  const sendTool = buildManifest(pluginDefinition).tools.find((tool) => tool.name === "send_document");
  assert.deepEqual(sendTool.parameters.required, ["phone", "document"]);
  assert.equal("rows" in sendTool.parameters.properties, false);
  const missing = await runWablas("send_message", { phone: "+6281234567890" }, { source: "node" });
  assert.equal(missing.error.kind, "invalid_input");
  const national = await runWablas("send_message", { phone: "081234567890", message: "Hi" }, { source: "node" });
  assert.equal(national.error.kind, "invalid_input");
  assert.equal(missing.calls.length + national.calls.length, 0);
});

test("without WABLAS_SECRET_KEY the Authorization header is the token alone", async () => {
  const { calls } = await runWablas("send_message", { phone: "+6281234567890", message: "Hi" }, { source: "node", environment: { WABLAS_SECRET_KEY: "" } });
  assert.equal(calls[0].headers.authorization, "wablas-token-1");
});

test("Wablas's 500 \"token invalid\" is an auth_error that is not retried", async () => {
  const { error, calls } = await runWablas("list_message_reports", {}, { responses: [{ status: 500, body: { status: false, message: "token invalid" } }, { body: { status: true, message: [] } }] });
  assert.equal(error.kind, "auth_error");
  assert.equal(calls.length, 1);
  const send = await runWablas("send_message", { phone: "+6281234567890", message: "Hi" }, { source: "node", responses: [{ status: 500, body: { status: false, message: "quota is not enough, please top up your quota." } }] });
  assert.equal(send.error.kind, "permission_denied");
  assert.doesNotMatch(send.error.message, /outcome unknown/);
});

test("status:false in a 200 is an error; resend is node only", async () => {
  const { error } = await runWablas("cancel_message", { message_id: "m1" }, { source: "node", responses: [{ body: { status: false, message: "message not found" } }] });
  assert.match(error.message, /message not found/);
  const toolNames = buildManifest(pluginDefinition).tools.map((tool) => tool.name);
  assert.equal(toolNames.includes("resend_message"), false);
  assert.ok(toolNames.includes("get_device_info"));
});

test("auth messages match case-insensitively, including secret key invalid and token is null", async () => {
  for (const message of ["Token Invalid", "TOKEN INVALID OR DEVICE EXPIRED.", "secret key invalid", "Secret Key Invalid", "token is null", "Token is null."]) {
    const { error, calls } = await runWablas("list_message_reports", {}, { responses: [{ status: 500, body: { status: false, message } }, { body: { status: true, message: [] } }] });
    assert.equal(error?.kind, "auth_error", message);
    assert.equal(calls.length, 1, `${message} is not retried`);
  }
});

test("send_video requires a caption", async () => {
  const sendVideo = buildManifest(pluginDefinition).tools.find((tool) => tool.name === "send_video");
  assert.deepEqual(sendVideo.parameters.required, ["phone", "video", "caption"]);
  const { error, calls } = await runWablas("send_video", { phone: "+6281234567890", video: "https://example.com/a.mp4" }, { source: "node" });
  assert.equal(error.kind, "invalid_input");
  assert.equal(calls.length, 0);
});

test("cancel_message needs the send opt-in as a tool", async () => {
  const refused = await runWablas("cancel_message", { message_id: "m1" }, { responses: [{ body: { status: true } }] });
  assert.equal(refused.error.kind, "permission_denied");
  assert.match(refused.error.message, /WABLAS_TOOL_ALLOW_SEND/);
  const allowed = await runWablas("cancel_message", { message_id: "m1" }, { environment: { WABLAS_TOOL_ALLOW_SEND: "1" }, responses: [{ body: { status: true } }] });
  if (allowed.error) throw allowed.error;
});

test("a full-number allowlist entry matches exactly; broad prefixes are refused", async () => {
  const longer = await runWablas("send_message", { phone: "+6281234567890", message: "Hi" }, { environment: { WABLAS_TOOL_ALLOW_SEND: "1", WABLAS_TOOL_RECIPIENT_ALLOWLIST: "+628123456789" } });
  assert.equal(longer.error.kind, "permission_denied");
  const broad = await runWablas("send_message", { phone: "+6281234567890", message: "Hi" }, { environment: { WABLAS_TOOL_ALLOW_SEND: "1", WABLAS_TOOL_RECIPIENT_ALLOWLIST: "+62*" } });
  assert.match(broad.error.message, /too broad/);
});
