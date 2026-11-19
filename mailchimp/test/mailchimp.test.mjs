import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createErrorParser } from "../lib/shared/rest-errors.mjs";
import { computeSubscriberHash } from "../lib/subscriber-hash.mjs";
import { pluginDefinition } from "../definition.mjs";

const ENVIRONMENT = { MAILCHIMP_API_KEY: "fake-mailchimp-test-key-us21" };
// md5("ada@example.com")
const ADA_HASH = "3e3417d7ef77d5932a6734b916515ed5";

async function runMailchimp(operationName, args, { environment = ENVIRONMENT, source = "tool", responses = [{ body: {} }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("computeSubscriberHash is the md5 of the trimmed, lower-cased address", () => {
  assert.equal(computeSubscriberHash(" Ada@Example.COM "), computeSubscriberHash("ada@example.com"));
  assert.equal(computeSubscriberHash("ada@example.com"), ADA_HASH);
});

test("get_member takes an email and sends its subscriber hash", async () => {
  const { error, calls } = await runMailchimp("get_member", { list_id: "l1", email: "Ada@Example.com" });
  if (error) throw error;
  assert.equal(new URL(calls[0].url).pathname, `/3.0/lists/l1/members/${ADA_HASH}`);
});

test("upsert_member derives the hash from email_address when no subscriber_hash is given", async () => {
  const environment = { ...ENVIRONMENT, MAILCHIMP_TOOL_ALLOW_MEMBER_WRITES: "1" };
  const { error, calls } = await runMailchimp("upsert_member", { list_id: "l1", email_address: "ada@example.com", status_if_new: "pending" }, { environment });
  if (error) throw error;
  assert.equal(calls[0].method, "PUT");
  assert.equal(new URL(calls[0].url).pathname, `/3.0/lists/l1/members/${ADA_HASH}`);
  assert.deepEqual(calls[0].json, { email_address: "ada@example.com", status_if_new: "pending" });
});

test("a subscriber_hash that does not match the email or email_address given is refused", async () => {
  const otherHash = computeSubscriberHash("eve@example.com");
  for (const args of [
    { list_id: "l1", subscriber_hash: otherHash, email: "ada@example.com" },
    { list_id: "l1", subscriber_hash: otherHash, email_address: "ada@example.com", status_if_new: "subscribed" },
  ]) {
    const operationName = args.email_address ? "upsert_member" : "get_member";
    const { error, calls } = await runMailchimp(operationName, args, { source: "node" });
    assert.equal(error?.kind, "invalid_input", operationName);
    assert.match(error.message, /does not match/);
    assert.equal(calls.length, 0);
  }
  const matching = await runMailchimp("get_member", { list_id: "l1", subscriber_hash: ADA_HASH.toUpperCase(), email: "Ada@Example.com" }, { source: "node" });
  if (matching.error) throw matching.error;
});

test("api_request as a tool only reads allowlisted paths: no webhooks, also not through encoded dot segments", async () => {
  const refusedPaths = [
    "/lists/abc/webhooks",
    "/lists/abc/members/%2e%2e/webhooks",
    "/lists/abc/members/%252e%252e/webhooks",
    "/ping/%2e%2e/batch-webhooks",
    "/ping/%252e%252e/batch-webhooks",
    "/batch-webhooks",
    "/authorized-apps",
    "/lists/abc/members/a%2f..%2f..%2fwebhooks",
  ];
  for (const path of refusedPaths) {
    const refused = await runMailchimp("api_request", { path });
    assert.equal(refused.error?.kind, "permission_denied", path);
    assert.equal(refused.calls.length, 0, path);
  }
  const allowed = await runMailchimp("api_request", { path: "/lists/abc/merge-fields" });
  if (allowed.error) throw allowed.error;
  const fromNode = await runMailchimp("api_request", { path: "/lists/abc/webhooks" }, { source: "node" });
  if (fromNode.error) throw fromNode.error;
});

test("member operations without an email or subscriber_hash are refused before any request", async () => {
  const { error, calls } = await runMailchimp("get_member", { list_id: "l1" });
  assert.equal(error.kind, "invalid_input");
  assert.equal(calls.length, 0);
});

test("member writes need MAILCHIMP_TOOL_ALLOW_MEMBER_WRITES as tools; nodes are not limited", async () => {
  const args = { list_id: "l1", email: "ada@example.com", tags: [{ name: "vip", status: "active" }] };
  const refused = await runMailchimp("update_member_tags", args);
  assert.equal(refused.error.kind, "permission_denied");
  assert.equal(refused.calls.length, 0);
  const fromNode = await runMailchimp("update_member_tags", args, { source: "node" });
  if (fromNode.error) throw fromNode.error;
  assert.equal(fromNode.calls.length, 1);
});

test("sends, schedules, archives and permanent deletes are node only", () => {
  const toolNames = buildManifest(pluginDefinition).tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["send_campaign", "schedule_campaign", "unschedule_campaign", "archive_member", "delete_member_permanently"]) {
    assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
  }
  assert.equal(toolNames.includes("get_member"), true);
});

test("the data center comes from the key suffix, or MAILCHIMP_SERVER_PREFIX", async () => {
  const fromKey = await runMailchimp("ping", {});
  assert.equal(new URL(fromKey.calls[0].url).origin, "https://us21.api.mailchimp.com");
  const fromPrefix = await runMailchimp("ping", {}, { environment: { ...ENVIRONMENT, MAILCHIMP_SERVER_PREFIX: "us6" } });
  assert.equal(new URL(fromPrefix.calls[0].url).origin, "https://us6.api.mailchimp.com");
});

test("a key without a valid data center suffix is refused before any request", async () => {
  for (const apiKey of ["0123456789abcdef", "abc-us21.evil.example", "abc-US21/x"]) {
    const { error, calls } = await runMailchimp("ping", {}, { environment: { MAILCHIMP_API_KEY: apiKey } });
    assert.equal(error.kind, "invalid_input", apiKey);
    assert.equal(calls.length, 0);
  }
  const badPrefix = await runMailchimp("ping", {}, { environment: { ...ENVIRONMENT, MAILCHIMP_SERVER_PREFIX: "evil.example/" } });
  assert.equal(badPrefix.error.kind, "invalid_input");
});

test("Mailchimp problem+json errors map to kinds", () => {
  const parseDeclared = createErrorParser(pluginDefinition.restSpec.errors);
  const cases = [
    [401, "auth_error", { type: "x", title: "API Key Invalid", status: 401, detail: "Your API key may be invalid, or you've attempted to access the wrong datacenter." }],
    [404, "not_found", { title: "Resource Not Found", status: 404, detail: "The requested resource could not be found." }],
    [400, "invalid_input", { title: "Member Exists", status: 400, detail: "ada@example.com is already a list member." }],
    [403, "permission_denied", { title: "User Disabled", status: 403, detail: "This account has been deactivated." }],
    [429, "rate_limited", { title: "TooManyRequests", status: 429, detail: "You have exceeded the limit of 10 simultaneous connections." }],
  ];
  for (const [status, kind, body] of cases) {
    const parsed = parseDeclared(status, body);
    assert.equal(parsed.kind, kind, body.title);
    assert.ok(parsed.message.startsWith(body.detail), parsed.message);
  }
});
