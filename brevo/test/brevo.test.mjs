import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createErrorParser } from "../lib/shared/rest-errors.mjs";
import { pluginDefinition } from "../definition.mjs";

const API_KEY = { BREVO_API_KEY: "xkeysib-test-key-1" };
const SEND_ALLOWED = { ...API_KEY, BREVO_TOOL_ALLOW_SEND: "1" };
const mail = {
  sender_email: "shop@example.com",
  to: [{ email: "ada@example.com", name: "Ada" }],
  bcc: [{ email: "boss@other.example" }],
  subject: "Hi",
  html_content: "<p>Hello</p>",
};

async function runBrevo(operationName, args, { environment = API_KEY, source = "tool", responses = [{ status: 201, body: { messageId: "<m1@smtp-relay.mailin.fr>" } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("manifest: api key, opt-ins and the allowlist are the plugin's env; sends and deletes are guarded", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions.env.sort(), ["BREVO_API_KEY", "BREVO_TOOL_ALLOW_CONTACT_WRITES", "BREVO_TOOL_ALLOW_SEND", "BREVO_TOOL_RECIPIENT_ALLOWLIST"]);
  const toolNames = manifest.tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["delete_contact", "send_campaign_now", "list_webhooks", "get_webhook"]) assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
  assert.equal(toolNames.includes("send_transactional_email"), true);
});

test("send_transactional_email as a tool needs the opt-in", async () => {
  const { error, calls } = await runBrevo("send_transactional_email", { ...mail, bcc: [] });
  assert.equal(error.kind, "permission_denied");
  assert.match(error.message, /BREVO_TOOL_ALLOW_SEND/);
  assert.equal(calls.length, 0);
});

test("with an allowlist, every to/cc/bcc address of a tool send must match it", async () => {
  const environment = { ...SEND_ALLOWED, BREVO_TOOL_RECIPIENT_ALLOWLIST: "@example.com" };
  const refused = await runBrevo("send_transactional_email", mail, { environment });
  assert.equal(refused.error.kind, "permission_denied");
  assert.match(refused.error.message, /boss@other\.example/);
  assert.equal(refused.calls.length, 0);
  const ccRefused = await runBrevo("send_transactional_email", { ...mail, bcc: [], cc: [{ email: "x@evil.example" }] }, { environment });
  assert.equal(ccRefused.error.kind, "permission_denied");
  const allowed = await runBrevo("send_transactional_email", { ...mail, bcc: [] }, { environment });
  if (allowed.error) throw allowed.error;
  assert.deepEqual(allowed.calls[0].json.to, [{ email: "ada@example.com", name: "Ada" }]);
});

test("with an allowlist, a tool send's reply_to_email must match it too", async () => {
  const environment = { ...SEND_ALLOWED, BREVO_TOOL_RECIPIENT_ALLOWLIST: "@example.com" };
  const refused = await runBrevo("send_transactional_email", { ...mail, bcc: [], reply_to_email: "attacker@other.example" }, { environment });
  assert.equal(refused.error?.kind, "permission_denied");
  assert.match(refused.error.message, /attacker@other\.example/);
  assert.equal(refused.calls.length, 0);
  const allowed = await runBrevo("send_transactional_email", { ...mail, bcc: [], reply_to_email: "help@example.com" }, { environment });
  if (allowed.error) throw allowed.error;
});

test("tool sends refuse address headers in email_headers (any case); nodes may set them", async () => {
  for (const headerName of ["To", "cc", "BCC", "reply-to", "From", "Sender"]) {
    const refused = await runBrevo("send_transactional_email", { ...mail, bcc: [], email_headers: { [headerName]: "x@evil.example" } }, { environment: SEND_ALLOWED });
    assert.equal(refused.error?.kind, "permission_denied", headerName);
    assert.equal(refused.calls.length, 0, headerName);
  }
  const customHeader = await runBrevo("send_transactional_email", { ...mail, bcc: [], email_headers: { "X-Mailin-custom": "order:12" } }, { environment: SEND_ALLOWED });
  if (customHeader.error) throw customHeader.error;
  const fromNode = await runBrevo("send_transactional_email", { ...mail, email_headers: { Sender: "ops@example.com" } }, { source: "node" });
  if (fromNode.error) throw fromNode.error;
});

test("api_request as a tool only reads allowlisted paths: no webhooks, sent email content or encoded bypasses", async () => {
  const refusedPaths = ["/webhooks", "/contacts/%2e%2e/webhooks", "/contacts/%252e%252e/webhooks", "/contacts/%2E%2E/%2e%2e/v3/webhooks", "/smtp/emails/abc-uuid", "/smtp/emails", "/contacts/a%2f..%2f..%2fwebhooks"];
  for (const path of refusedPaths) {
    const refused = await runBrevo("api_request", { path }, { responses: [{ body: {} }] });
    assert.equal(refused.error?.kind, "permission_denied", path);
    assert.equal(refused.calls.length, 0, path);
  }
  const allowed = await runBrevo("api_request", { path: "/senders" }, { responses: [{ body: { senders: [] } }] });
  if (allowed.error) throw allowed.error;
  const fromNode = await runBrevo("api_request", { path: "/smtp/emails/abc-uuid" }, { source: "node", responses: [{ body: { body: "<p>code</p>" } }] });
  if (fromNode.error) throw fromNode.error;
});

test("a node send ignores the allowlist; malformed addresses are refused for everyone", async () => {
  const fromNode = await runBrevo("send_transactional_email", mail, { source: "node", environment: { ...API_KEY, BREVO_TOOL_RECIPIENT_ALLOWLIST: "@example.com" } });
  if (fromNode.error) throw fromNode.error;
  assert.equal(fromNode.calls.length, 1);
  for (const badRecipient of [{ email: "Ada <ada@example.com>" }, { name: "no address" }, { email: "ada@example.com\r\nBcc: x@y.z" }]) {
    const { error, calls } = await runBrevo("send_transactional_email", { ...mail, to: [badRecipient] }, { source: "node" });
    assert.equal(error.kind, "invalid_input", JSON.stringify(badRecipient));
    assert.equal(calls.length, 0);
  }
});

test("a failed send is not retried and says how to check", async () => {
  const { error, calls } = await runBrevo("send_transactional_email", { ...mail, bcc: [] }, { source: "node", responses: [{ status: 502, body: { message: "bad gateway" } }] });
  assert.equal(calls.length, 1);
  assert.equal(error.retryable, false);
  assert.match(error.message, /list_email_events/);
});

test("contact writes need BREVO_TOOL_ALLOW_CONTACT_WRITES as tools", async () => {
  const refused = await runBrevo("create_contact", { email: "ada@example.com" });
  assert.equal(refused.error.kind, "permission_denied");
  const allowed = await runBrevo("create_contact", { email: "ada@example.com" }, { environment: { ...API_KEY, BREVO_TOOL_ALLOW_CONTACT_WRITES: "1" }, responses: [{ status: 201, body: { id: 21 } }] });
  if (allowed.error) throw allowed.error;
  assert.deepEqual(allowed.output.data, { id: 21 });
});

test("Brevo {code, message} errors map to kinds", () => {
  const parseDeclared = createErrorParser(pluginDefinition.restSpec.errors);
  const cases = [
    [401, "auth_error", { code: "unauthorized", message: "Key not found" }],
    [404, "not_found", { code: "document_not_found", message: "Contact does not exist" }],
    [400, "invalid_input", { code: "duplicate_parameter", message: "Contact already exist" }],
    [400, "permission_denied", { code: "not_enough_credits", message: "Not enough credits" }],
    [403, "permission_denied", { code: "permission_denied", message: "Unable to send email. Your SMTP account is not yet activated." }],
  ];
  for (const [status, kind, body] of cases) {
    const parsed = parseDeclared(status, body);
    assert.equal(parsed.kind, kind, body.code);
    assert.equal(parsed.message, `${body.message} (${body.code})`);
  }
});
