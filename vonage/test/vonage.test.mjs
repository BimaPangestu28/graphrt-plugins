import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const BASE_ENVIRONMENT = { VONAGE_API_KEY: "key-1", VONAGE_API_SECRET: "vonage-secret-1" };
const SEND_ALLOWED = { VONAGE_TOOL_ALLOW_SEND: "1", VONAGE_TOOL_RECIPIENT_ALLOWLIST: "+62812*, +4477*" };
const ACCEPTED = [{ status: 202, body: { message_uuid: "u1" } }];

async function runVonage(operationName, args, { environment = {}, source = "tool", responses = ACCEPTED } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { ...BASE_ENVIRONMENT, ...environment }, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

const sms = { to: "+6281234567890", from: "Acme", text: "Hi" };

test("tool sends need the opt-in, a set allowlist and a matching recipient", async () => {
  const noOptIn = await runVonage("send_sms", sms, { environment: { VONAGE_TOOL_RECIPIENT_ALLOWLIST: "+6281*" } });
  assert.match(noOptIn.error.message, /VONAGE_TOOL_ALLOW_SEND/);
  const noAllowlist = await runVonage("send_sms", sms, { environment: { VONAGE_TOOL_ALLOW_SEND: "1" } });
  assert.match(noAllowlist.error.message, /VONAGE_TOOL_RECIPIENT_ALLOWLIST/);
  const outside = await runVonage("send_whatsapp_text", { ...sms, to: "+15550100000", from: "+14157386102" }, { environment: SEND_ALLOWED });
  assert.equal(outside.error.kind, "permission_denied");
  assert.equal(noOptIn.calls.length + noAllowlist.calls.length + outside.calls.length, 0);
  const allowed = await runVonage("send_sms", { ...sms, to: "+44 7700 900000" }, { environment: SEND_ALLOWED });
  if (allowed.error) throw allowed.error;
  assert.equal(allowed.calls[0].json.to, "447700900000");
});

test("nodes are not limited by the allowlist but numbers must still be E.164 with +", async () => {
  const node = await runVonage("send_sms", { ...sms, to: "+15550100000" }, { source: "node" });
  if (node.error) throw node.error;
  for (const badNumber of ["6281234567890", "081234567890"]) {
    const { error, calls } = await runVonage("send_sms", { ...sms, to: badNumber }, { source: "node" });
    assert.equal(error?.kind, "invalid_input", badNumber);
    assert.equal(calls.length, 0);
  }
  const badSender = await runVonage("send_whatsapp_text", { ...sms, from: "Acme" }, { source: "node" });
  assert.equal(badSender.error.kind, "invalid_input");
});

test("SMS senders keep alphanumeric ids; + numbers lose the +", async () => {
  const alphanumeric = await runVonage("send_sms", sms, { source: "node" });
  assert.equal(alphanumeric.calls[0].json.from, "Acme");
  const numeric = await runVonage("send_sms", { ...sms, from: "+447700900001" }, { source: "node" });
  assert.equal(numeric.calls[0].json.from, "447700900001");
});

test("VONAGE_MESSAGES_REGION picks the Messages host; Number Insight and balance keep their hosts", async () => {
  const eu = await runVonage("send_sms", sms, { source: "node", environment: { VONAGE_MESSAGES_REGION: "eu" } });
  assert.equal(eu.calls[0].url, "https://api-eu.nexmo.com/v1/messages");
  const insight = await runVonage("number_insight", { level: "basic", number: "+6281234567890" }, { environment: { VONAGE_MESSAGES_REGION: "ap" }, responses: [{ body: { status: 0 } }] });
  assert.equal(new URL(insight.calls[0].url).origin, "https://api.nexmo.com");
  const bad = await runVonage("get_balance", {}, { environment: { VONAGE_MESSAGES_REGION: "evil.example/" } });
  assert.equal(bad.error.kind, "invalid_input");
});

test("Number Insight errors in 200 bodies map by status", async () => {
  const badCredentials = await runVonage("number_insight", { level: "basic", number: "+6281234567890" }, { responses: [{ body: { status: 4, status_message: "Invalid credentials" } }] });
  assert.equal(badCredentials.error.kind, "auth_error");
  assert.match(badCredentials.error.message, /Invalid credentials/);
});

test("Number Insight is unsafe: a 5xx is not retried", async () => {
  const { error, calls } = await runVonage("number_insight", { level: "advanced", number: "+6281234567890" }, { source: "node", responses: [{ status: 503, body: {} }, { body: { status: 0 } }] });
  assert.equal(calls.length, 1);
  assert.equal(error.retryable, false);
});

test("no operation takes a webhook_url", () => {
  const manifest = buildManifest(pluginDefinition);
  const propertyNames = manifest.nodes.flatMap((node) => Object.keys(node.config_schema.properties ?? {}));
  assert.equal(propertyNames.some((propertyName) => /webhook|callback/i.test(propertyName)), false);
});

test("paid Number Insight levels need VONAGE_TOOL_ALLOW_INSIGHT=1 as a tool; basic stays open", async () => {
  for (const level of ["standard", "advanced"]) {
    const refused = await runVonage("number_insight", { level, number: "+6281234567890" }, { responses: [{ body: { status: 0 } }] });
    assert.equal(refused.error?.kind, "permission_denied", level);
    assert.match(refused.error.message, /VONAGE_TOOL_ALLOW_INSIGHT/);
    assert.equal(refused.calls.length, 0);
  }
  const allowed = await runVonage("number_insight", { level: "advanced", number: "+6281234567890" }, { environment: { VONAGE_TOOL_ALLOW_INSIGHT: "1" }, responses: [{ body: { status: 0 } }] });
  if (allowed.error) throw allowed.error;
  const basic = await runVonage("number_insight", { level: "basic", number: "+6281234567890" }, { responses: [{ body: { status: 0 } }] });
  if (basic.error) throw basic.error;
  const node = await runVonage("number_insight", { level: "standard", number: "+6281234567890" }, { source: "node", responses: [{ body: { status: 0 } }] });
  if (node.error) throw node.error;
});

test("send_whatsapp_custom refuses recipient and sender keys inside custom", async () => {
  for (const smuggledKey of ["to", "recipient_type", "from"]) {
    const { error, calls } = await runVonage("send_whatsapp_custom", { to: "+6281234567890", from: "+14157386102", custom: { type: "text", text: { body: "x" }, [smuggledKey]: "15550100000" } }, { source: "node" });
    assert.equal(error?.kind, "invalid_input", smuggledKey);
    assert.equal(calls.length, 0);
  }
});

test("mark_whatsapp_read is not offered (it needs JWT auth)", () => {
  assert.equal(pluginDefinition.operations.some((operation) => operation.name === "mark_whatsapp_read"), false);
});

test("a full-number allowlist entry matches exactly; broad prefixes are refused", async () => {
  const longer = await runVonage("send_sms", { ...sms, to: "+6281234567890" }, { environment: { VONAGE_TOOL_ALLOW_SEND: "1", VONAGE_TOOL_RECIPIENT_ALLOWLIST: "+628123456789" } });
  assert.equal(longer.error.kind, "permission_denied");
  const broad = await runVonage("send_sms", sms, { environment: { VONAGE_TOOL_ALLOW_SEND: "1", VONAGE_TOOL_RECIPIENT_ALLOWLIST: "+44*" } });
  assert.equal(broad.error.kind, "invalid_input");
  assert.match(broad.error.message, /too broad/);
});
