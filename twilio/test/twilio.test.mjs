import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { decodeTwilioCursor, encodeTwilioCursor } from "../lib/twilio-paging.mjs";
import { pluginDefinition } from "../definition.mjs";

const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const BASE_ENVIRONMENT = { TWILIO_ACCOUNT_SID: ACCOUNT_SID, TWILIO_AUTH_TOKEN: "twilio-token-1" };
const SEND_ALLOWED = { TWILIO_TOOL_ALLOW_SEND: "1", TWILIO_TOOL_RECIPIENT_ALLOWLIST: "+62812*" };

async function runTwilio(operationName, args, { environment = {}, source = "tool", responses = [{ status: 201, body: { sid: "SM1" } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { ...BASE_ENVIRONMENT, ...environment }, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

const formOf = (call) => Object.fromEntries(new URLSearchParams(call.body));

test("send_sms as a tool: the allowlist must be set and match the recipient", async () => {
  const unset = await runTwilio("send_sms", { to: "+6281234567890", from: "+15005550006", body: "Hi" }, { environment: { TWILIO_TOOL_ALLOW_SEND: "1" } });
  assert.equal(unset.error.kind, "permission_denied");
  assert.match(unset.error.message, /TWILIO_TOOL_RECIPIENT_ALLOWLIST/);
  const outside = await runTwilio("send_sms", { to: "+15550100000", from: "+15005550006", body: "Hi" }, { environment: SEND_ALLOWED });
  assert.equal(outside.error.kind, "permission_denied");
  assert.equal(outside.calls.length + unset.calls.length, 0);
  const allowed = await runTwilio("send_sms", { to: "+62 812 3456 7890", from: "+15005550006", body: "Hi" }, { environment: SEND_ALLOWED });
  if (allowed.error) throw allowed.error;
  assert.equal(formOf(allowed.calls[0]).To, "+6281234567890");
});

test("send_sms without the opt-in is refused for tools; nodes ignore both envs", async () => {
  const noOptIn = await runTwilio("send_sms", { to: "+6281234567890", body: "Hi" }, { environment: { TWILIO_TOOL_RECIPIENT_ALLOWLIST: "+6281*" } });
  assert.equal(noOptIn.error.kind, "permission_denied");
  assert.match(noOptIn.error.message, /TWILIO_TOOL_ALLOW_SEND/);
  const node = await runTwilio("send_sms", { to: "+15550100000", messaging_service_sid: "MG1", body: "Hi" }, { source: "node" });
  if (node.error) throw node.error;
  assert.deepEqual(formOf(node.calls[0]), { To: "+15550100000", Body: "Hi", MessagingServiceSid: "MG1" });
});

test("numbers without + are refused before any request, for nodes too", async () => {
  for (const badNumber of ["081234567890", "6281234567890", "whatsapp:+6281234567890"]) {
    const { error, calls } = await runTwilio("send_sms", { to: badNumber, body: "Hi" }, { source: "node" });
    assert.equal(error?.kind, "invalid_input", badNumber);
    assert.equal(calls.length, 0);
  }
  const call = await runTwilio("create_call", { to: "0812345678", from: "+15005550006", twiml: "<Response/>" }, { source: "node" });
  assert.equal(call.error.kind, "invalid_input");
});

test("send_whatsapp prefixes To and From with whatsapp: and checks the bare number", async () => {
  const { error, calls } = await runTwilio("send_whatsapp", { to: "+6281234567890", from: "+1 415 523 8886", body: "Hi" }, { environment: SEND_ALLOWED });
  if (error) throw error;
  assert.equal(formOf(calls[0]).To, "whatsapp:+6281234567890");
  assert.equal(formOf(calls[0]).From, "whatsapp:+14155238886");
});

test("no tool or node takes a status callback; calls and deletes are node only", () => {
  const manifest = buildManifest(pluginDefinition);
  const allProperties = [...manifest.tools.map((tool) => tool.parameters), ...manifest.nodes.map((node) => node.config_schema)].flatMap((schema) => Object.keys(schema.properties ?? {}));
  assert.equal(allProperties.some((propertyName) => /callback/i.test(propertyName)), false);
  const toolNames = manifest.tools.map((tool) => tool.name);
  assert.equal(toolNames.includes("create_call"), false);
  assert.equal(toolNames.includes("delete_message"), false);
  assert.ok(toolNames.includes("send_sms"));
});

test("list_messages returns the messages and a Page:PageToken cursor, then follows it", async () => {
  const nextPageUri = `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json?PageSize=1&Page=1&PageToken=PAabc`;
  const first = await runTwilio("list_messages", { page_size: 1 }, { responses: [{ body: { messages: [{ sid: "SM1" }], next_page_uri: nextPageUri } }] });
  if (first.error) throw first.error;
  assert.deepEqual(first.output, { data: [{ sid: "SM1" }], next_cursor: "1:PAabc" });
  const tool = buildManifest(pluginDefinition).tools.find((candidate) => candidate.name === "list_messages");
  assert.equal("page_token" in tool.parameters.properties, false);
  assert.ok("cursor" in tool.parameters.properties);
  const second = await runTwilio("list_messages", { page_size: 1, cursor: first.output.next_cursor }, { responses: [{ body: { messages: [], next_page_uri: null } }] });
  const secondQuery = Object.fromEntries(new URL(second.calls[0].url).searchParams);
  assert.deepEqual(secondQuery, { PageSize: "1", Page: "1", PageToken: "PAabc" });
  assert.equal(second.output.next_cursor, null);
});

test("cursors that are not Page:PageToken are refused", async () => {
  assert.throws(() => decodeTwilioCursor("https://evil.example/x"), (error) => error.kind === "invalid_input");
  assert.equal(encodeTwilioCursor(null), null);
  assert.equal(encodeTwilioCursor("/x.json?Page=1"), null);
  const { error, calls } = await runTwilio("list_calls", { cursor: "1:PA&x=1" });
  assert.equal(error.kind, "invalid_input");
  assert.equal(calls.length, 0);
});

test("a malformed TWILIO_ACCOUNT_SID is refused before any request", async () => {
  const { error, calls } = await runTwilio("get_balance", {}, { environment: { TWILIO_ACCOUNT_SID: "AC123/../x" } });
  assert.equal(error.kind, "invalid_input");
  assert.match(error.message, /TWILIO_ACCOUNT_SID/);
  assert.equal(calls.length, 0);
});

test("Twilio's {code, message} errors map to kinds", async () => {
  const { error } = await runTwilio("get_balance", {}, { responses: [{ status: 401, body: { code: 20003, message: "Authenticate", status: 401 } }] });
  assert.equal(error.kind, "auth_error");
  assert.match(error.message, /Authenticate \(20003\)/);
});

test("hidden page/page_token args are dropped; only a validated cursor sets them", async () => {
  const { calls } = await runTwilio("list_messages", { page: 7, page_token: "PAsmuggled" }, { responses: [{ body: { messages: [], next_page_uri: null } }] });
  const query = Object.fromEntries(new URL(calls[0].url).searchParams);
  assert.equal(query.Page, undefined);
  assert.equal(query.PageToken, undefined);
});

test("a full-number allowlist entry matches exactly; broad prefixes are refused", async () => {
  const exact = { TWILIO_TOOL_ALLOW_SEND: "1", TWILIO_TOOL_RECIPIENT_ALLOWLIST: "+628123456789" };
  const longer = await runTwilio("send_sms", { to: "+6281234567890", body: "Hi" }, { environment: exact });
  assert.equal(longer.error.kind, "permission_denied");
  const same = await runTwilio("send_sms", { to: "+628123456789", messaging_service_sid: "MG1", body: "Hi" }, { environment: exact });
  if (same.error) throw same.error;
  const broad = await runTwilio("send_sms", { to: "+6281234567890", body: "Hi" }, { environment: { TWILIO_TOOL_ALLOW_SEND: "1", TWILIO_TOOL_RECIPIENT_ALLOWLIST: "+62*" } });
  assert.equal(broad.error.kind, "invalid_input");
  assert.match(broad.error.message, /too broad/);
  assert.equal(longer.calls.length + broad.calls.length, 0);
});

test("paid lookups need TWILIO_TOOL_ALLOW_LOOKUP=1 as a tool; the free lookup does not", async () => {
  const paid = await runTwilio("lookup_phone_number_data", { phone_number: "+6281234567890", fields: ["line_type_intelligence"] }, { responses: [{ body: {} }] });
  assert.equal(paid.error.kind, "permission_denied");
  assert.match(paid.error.message, /TWILIO_TOOL_ALLOW_LOOKUP/);
  const free = await runTwilio("lookup_phone_number", { phone_number: "+6281234567890" }, { responses: [{ body: { valid: true } }] });
  if (free.error) throw free.error;
});
