import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createErrorParser } from "../lib/shared/rest-errors.mjs";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { normalizeSendArgs } from "../lib/resend-mail.mjs";
import { remapInvalidApiKeyError } from "../lib/resend-errors.mjs";
import { pluginDefinition } from "../definition.mjs";

const API_KEY = { RESEND_API_KEY: "re_test_key_1" };
const SEND_ALLOWED = { ...API_KEY, RESEND_TOOL_ALLOW_SEND: "1" };
const mail = { from: "Acme <news@example.com>", to: ["ada@example.com"], bcc: ["boss@other.example"], subject: "Hi", text: "Hello" };

const readHeader = (call, headerName) => Object.entries(call.headers).find(([name]) => name.toLowerCase() === headerName)?.[1];

async function runResend(operationName, args, { environment = API_KEY, source = "tool", responses = [{ body: { id: "e1" } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("normalizeSendArgs trims addresses, accepts a single string and returns every recipient", () => {
  const { args, recipients } = normalizeSendArgs({ ...mail, to: " ada@example.com ", cc: ["cc@example.com"], reply_to: "help@example.com" });
  assert.deepEqual(args.to, ["ada@example.com"]);
  assert.deepEqual(args.reply_to, ["help@example.com"]);
  assert.deepEqual(recipients, ["ada@example.com", "cc@example.com", "boss@other.example", "help@example.com"]);
  assert.equal(args.from, "Acme <news@example.com>");
});

test("normalizeSendArgs refuses bad input before any request", () => {
  const refusals = [
    { ...mail, to: [] },
    { ...mail, to: ["Ada <ada@example.com>"] },
    { ...mail, from: "news@example.com\r\nBcc: x@example.com" },
    { ...mail, from: "not an address" },
    { ...mail, text: undefined },
    { ...mail, subject: undefined },
    { ...mail, text: undefined, template_id: "t1", html: "<p>x</p>" },
  ];
  for (const args of refusals) assert.throws(() => normalizeSendArgs(args), (error) => error.kind === "invalid_input", JSON.stringify(args));
  assert.doesNotThrow(() => normalizeSendArgs({ from: mail.from, to: mail.to, template_id: "welcome", template_variables: { NAME: "Ada" } }));
});

test("remapInvalidApiKeyError turns Resend's 400 'API key is invalid' into auth_error and leaves others", () => {
  const remapped = remapInvalidApiKeyError(new PluginError("API error 400: API key is invalid (validation_error)", { kind: "invalid_input" }));
  assert.equal(remapped.kind, "auth_error");
  assert.match(remapped.message, /API key is invalid/);
  const other = new PluginError("API error 400: Invalid `to` field (validation_error)", { kind: "invalid_input" });
  assert.equal(remapInvalidApiKeyError(other), other);
});

test("a 400 invalid-key answer from any operation is an auth_error", async () => {
  const { error } = await runResend("list_domains", {}, { responses: [{ status: 400, body: { statusCode: 400, message: "API key is invalid", name: "validation_error" } }] });
  assert.equal(error.kind, "auth_error");
});

test("manifest: opt-in and allowlist env; batch send and cancel are node only", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions.env.sort(), ["RESEND_API_KEY", "RESEND_TOOL_ALLOW_SEND", "RESEND_TOOL_RECIPIENT_ALLOWLIST"]);
  const toolNames = manifest.tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["send_batch_emails", "cancel_email"]) assert.equal(toolNames.includes(nodeOnlyName), false);
  assert.deepEqual(manifest.tools.find((tool) => tool.name === "send_email").parameters.required, ["from", "to"]);
});

test("send_email as a tool: opt-in first, then every recipient against the allowlist", async () => {
  const noOptIn = await runResend("send_email", mail);
  assert.equal(noOptIn.error.kind, "permission_denied");
  const environment = { ...SEND_ALLOWED, RESEND_TOOL_RECIPIENT_ALLOWLIST: "@example.com" };
  const refused = await runResend("send_email", mail, { environment });
  assert.equal(refused.error.kind, "permission_denied");
  assert.match(refused.error.message, /boss@other\.example/);
  assert.equal(refused.calls.length, 0);
  const allowed = await runResend("send_email", { ...mail, bcc: [] }, { environment });
  if (allowed.error) throw allowed.error;
  assert.deepEqual(allowed.calls[0].json.to, ["ada@example.com"]);
});

test("send_email sends an Idempotency-Key and retries a 5xx with the same key", async () => {
  const { error, calls } = await runResend("send_email", mail, { source: "node", responses: [{ status: 500, body: { statusCode: 500, name: "application_error", message: "boom" } }, { body: { id: "e1" } }] });
  if (error) throw error;
  assert.equal(calls.length, 2);
  assert.ok(readHeader(calls[0], "idempotency-key"));
  assert.equal(readHeader(calls[0], "idempotency-key"), readHeader(calls[1], "idempotency-key"));
});

test("send_email from a node ignores the allowlist", async () => {
  const { error, calls } = await runResend("send_email", mail, { source: "node", environment: { ...API_KEY, RESEND_TOOL_RECIPIENT_ALLOWLIST: "@example.com" } });
  if (error) throw error;
  assert.equal(calls.length, 1);
});

test("every request carries a User-Agent (Resend refuses requests without one)", async () => {
  const { calls } = await runResend("list_domains", {}, { responses: [{ body: { data: [] } }] });
  assert.match(readHeader(calls[0], "user-agent"), /^graphrt-resend\//);
});

test("api_request as a tool only reads allowlisted paths (no API keys or webhook signing secrets)", async () => {
  const refusedPaths = ["/api-keys", "/webhooks", "/emails/%2e%2e/webhooks", "/domains/%252e%252e/webhooks", "/emails/e1", "/emails/receiving/r1", "/emails/%2572eceiving"];
  for (const path of refusedPaths) {
    const refused = await runResend("api_request", { path }, { responses: [{ body: {} }] });
    assert.equal(refused.error.kind, "permission_denied", path);
    assert.equal(refused.calls.length, 0, path);
  }
  const allowed = await runResend("api_request", { path: "/audiences" }, { responses: [{ body: { data: [] } }] });
  if (allowed.error) throw allowed.error;
});

test("get_email as a tool omits html and text (reset links, codes); nodes get the full email", async () => {
  const sentEmail = { object: "email", id: "e1", to: ["ada@example.com"], subject: "Reset", html: "<a href=https://x/reset?t=1>reset</a>", text: "code 123456", last_event: "delivered" };
  const fromTool = await runResend("get_email", { email_id: "e1" }, { responses: [{ body: sentEmail }] });
  if (fromTool.error) throw fromTool.error;
  assert.equal(fromTool.output.data.subject, "Reset");
  assert.match(fromTool.output.data.html, /omitted/);
  assert.match(fromTool.output.data.text, /omitted/);
  assert.doesNotMatch(JSON.stringify(fromTool.output.data), /123456|reset\?t=1/);
  const fromNode = await runResend("get_email", { email_id: "e1" }, { source: "node", responses: [{ body: sentEmail }] });
  assert.equal(fromNode.output.data.text, "code 123456");
});

test("send_email as a tool checks reply_to against the allowlist", async () => {
  const environment = { ...SEND_ALLOWED, RESEND_TOOL_RECIPIENT_ALLOWLIST: "@example.com" };
  const refused = await runResend("send_email", { ...mail, bcc: [], reply_to: ["attacker@other.example"] }, { environment });
  assert.equal(refused.error?.kind, "permission_denied");
  assert.equal(refused.calls.length, 0);
});

test("Resend error names map to kinds", () => {
  const parseDeclared = createErrorParser(pluginDefinition.restSpec.errors);
  const cases = [
    [401, "auth_error", "missing_api_key"],
    [401, "permission_denied", "restricted_api_key"],
    [403, "permission_denied", "invalid_permission"],
    [429, "rate_limited", "daily_quota_exceeded"],
    [409, "invalid_input", "invalid_idempotent_request"],
    [404, "not_found", "not_found"],
  ];
  for (const [status, kind, name] of cases) assert.equal(parseDeclared(status, { statusCode: status, name, message: "x" }).kind, kind, name);
  assert.equal(parseDeclared(409, { statusCode: 409, name: "concurrent_idempotent_requests", message: "x" }).retryable, true);
});
