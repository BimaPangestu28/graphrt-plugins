import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createErrorParser } from "../lib/shared/rest-errors.mjs";
import { buildMailSendBody } from "../lib/sendgrid-mail.mjs";
import { pluginDefinition } from "../definition.mjs";

const API_KEY = { SENDGRID_API_KEY: "SG.test-key-1" };
const SEND_ALLOWED = { ...API_KEY, SENDGRID_TOOL_ALLOW_SEND: "1" };
const mail = { from: "news@example.com", to: ["ada@example.com"], bcc: ["boss@other.example"], subject: "Hi", text: "Hello" };

async function runSendGrid(operationName, args, { environment = API_KEY, source = "tool", responses = [{ status: 202, body: "" }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("buildMailSendBody: one personalization, content in text-then-html order, optional fields only when set", () => {
  const { body, recipients } = buildMailSendBody({
    from: "news@example.com",
    from_name: "News",
    to: [" ada@example.com "],
    cc: ["cc@example.com"],
    reply_to: "help@example.com",
    subject: "Hi",
    text: "Hello",
    html: "<p>Hello</p>",
    categories: ["welcome"],
    send_at: "1767225600",
    asm_group_id: 42,
    sandbox_mode: true,
  });
  assert.deepEqual(body, {
    personalizations: [{ to: [{ email: "ada@example.com" }], cc: [{ email: "cc@example.com" }] }],
    from: { email: "news@example.com", name: "News" },
    reply_to: { email: "help@example.com" },
    subject: "Hi",
    content: [{ type: "text/plain", value: "Hello" }, { type: "text/html", value: "<p>Hello</p>" }],
    categories: ["welcome"],
    send_at: 1767225600,
    asm: { group_id: 42 },
    mail_settings: { sandbox_mode: { enable: true } },
  });
  assert.deepEqual(recipients, ["ada@example.com", "cc@example.com", "help@example.com"]);
});

test("buildMailSendBody: dynamic templates need no subject or content and carry their data in the personalization", () => {
  const { body } = buildMailSendBody({ from: "news@example.com", to: "ada@example.com", template_id: "d-123", dynamic_template_data: { first_name: "Ada" } });
  assert.deepEqual(body, { personalizations: [{ to: [{ email: "ada@example.com" }], dynamic_template_data: { first_name: "Ada" } }], from: { email: "news@example.com" }, template_id: "d-123" });
});

test("buildMailSendBody refuses missing recipients, missing content, display names and header injection", () => {
  const refusals = [
    { from: "a@example.com", to: [], subject: "x", text: "y" },
    { from: "a@example.com", to: ["b@example.com"], subject: "x" },
    { from: "a@example.com", to: ["b@example.com"], text: "y" },
    { from: "a@example.com", to: ["Ada <b@example.com>"], subject: "x", text: "y" },
    { from: "a@example.com\r\nBcc: c@example.com", to: ["b@example.com"], subject: "x", text: "y" },
    { from: "a@example.com", to: ["b@example.com"], subject: "x", text: "y", send_at: "soon" },
    { from: "a@example.com", to: ["b@example.com"], template_id: "d-1", dynamic_template_data: "nope" },
  ];
  for (const args of refusals) assert.throws(() => buildMailSendBody(args), (error) => error.kind === "invalid_input", JSON.stringify(args));
});

test("manifest: the opt-in, allowlist and region are allowed env; send_mail_raw is node only", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions.env.sort(), ["SENDGRID_API_KEY", "SENDGRID_REGION", "SENDGRID_TOOL_ALLOW_SEND", "SENDGRID_TOOL_RECIPIENT_ALLOWLIST"]);
  const toolNames = manifest.tools.map((tool) => tool.name);
  assert.equal(toolNames.includes("send_mail_raw"), false);
  assert.deepEqual(manifest.tools.find((tool) => tool.name === "send_mail").parameters.required, ["from", "to"]);
});

test("send_mail as a tool: opt-in first, then every recipient against the allowlist", async () => {
  const noOptIn = await runSendGrid("send_mail", mail);
  assert.equal(noOptIn.error.kind, "permission_denied");
  const environment = { ...SEND_ALLOWED, SENDGRID_TOOL_RECIPIENT_ALLOWLIST: "@example.com" };
  const refused = await runSendGrid("send_mail", mail, { environment });
  assert.equal(refused.error.kind, "permission_denied");
  assert.match(refused.error.message, /boss@other\.example/);
  assert.equal(refused.calls.length, 0);
  const allowed = await runSendGrid("send_mail", { ...mail, bcc: [] }, { environment });
  if (allowed.error) throw allowed.error;
  assert.deepEqual(allowed.calls[0].json.personalizations, [{ to: [{ email: "ada@example.com" }] }]);
});

test("send_mail as a tool checks reply_to against the allowlist too", async () => {
  const environment = { ...SEND_ALLOWED, SENDGRID_TOOL_RECIPIENT_ALLOWLIST: "@example.com" };
  const refused = await runSendGrid("send_mail", { ...mail, bcc: [], reply_to: "attacker@other.example" }, { environment });
  assert.equal(refused.error?.kind, "permission_denied");
  assert.match(refused.error.message, /attacker@other\.example/);
  assert.equal(refused.calls.length, 0);
  const allowed = await runSendGrid("send_mail", { ...mail, bcc: [], reply_to: "support@example.com" }, { environment });
  if (allowed.error) throw allowed.error;
});

test("send_mail from a node ignores the allowlist and the opt-in", async () => {
  const { error, calls } = await runSendGrid("send_mail", mail, { source: "node", environment: { ...API_KEY, SENDGRID_TOOL_RECIPIENT_ALLOWLIST: "@example.com" } });
  if (error) throw error;
  assert.equal(calls.length, 1);
});

test("a send that fails with a 5xx is not retried and says how to check", async () => {
  const { error, calls } = await runSendGrid("send_mail", mail, { source: "node", responses: [{ status: 500, body: { errors: [{ message: "internal" }] } }, { status: 202, body: "" }] });
  assert.equal(calls.length, 1);
  assert.equal(error.retryable, false);
  assert.match(error.message, /Email Activity/);
});

test("SENDGRID_REGION=eu uses the EU host; other values are refused", async () => {
  const eu = await runSendGrid("list_bounces", {}, { environment: { ...API_KEY, SENDGRID_REGION: "eu" }, responses: [{ body: [] }] });
  if (eu.error) throw eu.error;
  assert.equal(new URL(eu.calls[0].url).origin, "https://api.eu.sendgrid.com");
  const bad = await runSendGrid("list_bounces", {}, { environment: { ...API_KEY, SENDGRID_REGION: "evil.example" }, responses: [{ body: [] }] });
  assert.equal(bad.error.kind, "invalid_input");
  assert.equal(bad.calls.length, 0);
});

test("api_request as a tool only reads allowlisted paths", async () => {
  const refused = await runSendGrid("api_request", { path: "/api_keys" }, { responses: [{ body: {} }] });
  assert.equal(refused.error.kind, "permission_denied");
  assert.equal(refused.calls.length, 0);
  for (const path of ["/templates/%2e%2e/api_keys", "/templates/%252e%252e/api_keys", "/templates/a%252f..%252f..%252fapi_keys"]) {
    const encoded = await runSendGrid("api_request", { path }, { responses: [{ body: {} }] });
    assert.equal(encoded.error?.kind, "permission_denied", path);
    assert.equal(encoded.calls.length, 0, path);
  }
  const allowed = await runSendGrid("api_request", { path: "/categories" }, { responses: [{ body: [] }] });
  if (allowed.error) throw allowed.error;
  const fromNode = await runSendGrid("api_request", { path: "/api_keys" }, { source: "node", responses: [{ body: { result: [] } }] });
  if (fromNode.error) throw fromNode.error;
});

test("SendGrid error bodies map to the expected kinds", () => {
  const parseDeclared = createErrorParser(pluginDefinition.restSpec.errors);
  const unauthorized = parseDeclared(401, { errors: [{ field: null, message: "authorization required" }] });
  assert.equal(unauthorized.message, "authorization required");
  const invalid = parseDeclared(400, { errors: [{ field: "from.email", message: "The from address does not match a verified Sender Identity." }] });
  assert.match(invalid.message, /verified Sender Identity/);
});
