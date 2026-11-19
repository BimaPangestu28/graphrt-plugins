import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createErrorParser } from "../lib/shared/rest-errors.mjs";
import { clearCachedAccessTokens } from "../lib/google-auth.mjs";
import { pluginDefinition } from "../definition.mjs";

const STATIC_TOKEN = { GOOGLE_ACCESS_TOKEN: "ya29.static-token-1" };
const REFRESH_TRIO = { GOOGLE_REFRESH_TOKEN: "refresh-token-1", GOOGLE_CLIENT_ID: "client-1", GOOGLE_CLIENT_SECRET: "client-secret-1" };
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearCachedAccessTokens();
});

async function runGmail(operationName, args, { environment = STATIC_TOKEN, source = "tool", responses = [{ body: { id: "m9" } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

const mail = { to: ["ada@example.com"], bcc: ["boss@other.example"], subject: "Hi", text: "Hello" };

test("manifest: Google credentials, the opt-in, allowlist and attachment dir are allowed env", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions.env.sort(), ["GMAIL_ATTACHMENT_DIR", "GMAIL_TOOL_ALLOW_SEND", "GMAIL_TOOL_RECIPIENT_ALLOWLIST", "GOOGLE_ACCESS_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_SERVICE_ACCOUNT_JSON"]);
  const toolNames = manifest.tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["send_draft", "trash_message"]) assert.equal(toolNames.includes(nodeOnlyName), false);
  assert.deepEqual(manifest.tools.find((tool) => tool.name === "send_message").parameters.required, ["to", "subject"]);
});

test("send_message as a tool: opt-in first, then every recipient against the allowlist", async () => {
  const noOptIn = await runGmail("send_message", mail);
  assert.equal(noOptIn.error.kind, "permission_denied");
  const environment = { ...STATIC_TOKEN, GMAIL_TOOL_ALLOW_SEND: "1", GMAIL_TOOL_RECIPIENT_ALLOWLIST: "@example.com" };
  const refused = await runGmail("send_message", mail, { environment });
  assert.equal(refused.error.kind, "permission_denied");
  assert.match(refused.error.message, /boss@other\.example/);
  assert.equal(refused.calls.length, 0);
  const allowed = await runGmail("send_message", { ...mail, bcc: [] }, { environment });
  if (allowed.error) throw allowed.error;
  assert.equal(Buffer.from(allowed.calls[0].json.raw, "base64url").toString().startsWith("To: ada@example.com\r\n"), true);
});

test("send_message from a node ignores the allowlist", async () => {
  const { error, calls } = await runGmail("send_message", mail, { source: "node", environment: { ...STATIC_TOKEN, GMAIL_TOOL_RECIPIENT_ALLOWLIST: "@example.com" } });
  if (error) throw error;
  assert.equal(calls.length, 1);
});

test("a configured refresh grant is preferred over GOOGLE_ACCESS_TOKEN and its token is redacted", async () => {
  const tokenRequests = [];
  globalThis.fetch = async (url, init) => {
    tokenRequests.push({ url: String(url), form: Object.fromEntries(new URLSearchParams(init.body)) });
    return new Response(JSON.stringify({ access_token: "ya29.fresh-token-1", expires_in: 3600 }), { headers: { "content-type": "application/json" } });
  };
  const { output, calls } = await runGmail("get_profile", {}, { environment: { ...STATIC_TOKEN, ...REFRESH_TRIO }, responses: [{ body: { emailAddress: "ada@example.com", echo: "ya29.fresh-token-1" } }] });
  assert.equal(tokenRequests[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(tokenRequests[0].form.grant_type, "refresh_token");
  assert.equal(calls[0].headers.authorization, "Bearer ya29.fresh-token-1");
  assert.equal(output.data.echo, "[redacted]");
  await runGmail("get_profile", {}, { environment: { ...STATIC_TOKEN, ...REFRESH_TRIO } });
  assert.equal(tokenRequests.length, 1, "the token is cached");
});

test("a node's access_token wins over env credentials; no credential at all is an auth_error", async () => {
  const { calls } = await runGmail("get_profile", { access_token: "ya29.node-token-1" }, { source: "node", environment: REFRESH_TRIO });
  assert.equal(calls[0].headers.authorization, "Bearer ya29.node-token-1");
  const missing = await runGmail("get_profile", {}, { environment: {} });
  assert.equal(missing.error.kind, "auth_error");
  assert.match(missing.error.message, /GOOGLE_REFRESH_TOKEN/);
  assert.equal(missing.calls.length, 0);
});

test("the declared error mapping gives the expected kinds for Gmail bodies", () => {
  const parseDeclared = createErrorParser(pluginDefinition.restSpec.errors);
  const bodies = [
    [404, "not_found", { error: { code: 404, message: "Requested entity was not found.", errors: [{ reason: "notFound" }], status: "NOT_FOUND" } }],
    [403, "rate_limited", { error: { code: 403, message: "User-rate limit exceeded.", errors: [{ reason: "userRateLimitExceeded" }], status: "PERMISSION_DENIED" } }],
    [403, "permission_denied", { error: { code: 403, message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }], status: "PERMISSION_DENIED" } }],
    [400, "invalid_input", { error: { code: 400, message: "Invalid id value", errors: [{ reason: "invalidArgument" }], status: "INVALID_ARGUMENT" } }],
    [401, "auth_error", { error: { code: 401, message: "Request had invalid authentication credentials.", errors: [{ reason: "authError" }], status: "UNAUTHENTICATED" } }],
  ];
  for (const [status, expectedKind, body] of bodies) assert.equal(parseDeclared(status, body).kind, expectedKind, body.error.message);
});

test("get_attachment saves the base64url data into GMAIL_ATTACHMENT_DIR", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const directory = mkdtempSync(join(tmpdir(), "gmail-attachment-"));
  try {
    const pdfBytes = Buffer.from("%PDF-1.7 test");
    const { output, error } = await runGmail("get_attachment", { message_id: "m1", attachment_id: "a1" }, { environment: { ...STATIC_TOKEN, GMAIL_ATTACHMENT_DIR: directory }, responses: [{ body: { size: pdfBytes.length, data: pdfBytes.toString("base64url") } }] });
    if (error) throw error;
    const savedFile = output.data.saved_files[0];
    assert.equal(savedFile.content_type, "application/pdf");
    assert.deepEqual(readFileSync(savedFile.path), pdfBytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
