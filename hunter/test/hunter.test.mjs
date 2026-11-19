import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createErrorParser } from "../lib/shared/rest-errors.mjs";
import { pluginDefinition } from "../definition.mjs";

const API_KEY = { HUNTER_API_KEY: "fake-key" };

async function runHunter(operationName, args, { environment = API_KEY, source = "tool", responses = [{ body: { data: {} } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("manifest: deletes are node only; the key and the opt-in are the env", () => {
  const manifest = buildManifest(pluginDefinition);
  const toolNames = manifest.tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["delete_lead", "delete_leads_list"]) assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
  assert.deepEqual(manifest.permissions.env.sort(), ["HUNTER_API_KEY", "HUNTER_TOOL_ALLOW_LEAD_WRITES"]);
});

test("the API key goes in the X-API-KEY header, never the query", async () => {
  const { calls } = await runHunter("verify_email", { email: "ada@example.com" });
  assert.equal(calls[0].headers["x-api-key"] ?? calls[0].headers["X-API-KEY"], "fake-key");
  assert.equal(calls[0].url.includes("fake-key"), false);
});

test("credit-consuming calls are never retried after a 5xx and say how to check", async () => {
  for (const [operationName, args] of [["domain_search", { domain: "example.com" }], ["find_email", { domain: "example.com", full_name: "Ada Lovelace" }], ["verify_email", { email: "ada@example.com" }], ["enrich_company", { domain: "example.com" }]]) {
    const { error, calls } = await runHunter(operationName, args, { responses: [{ status: 502, body: {} }, { body: { data: {} } }] });
    assert.equal(calls.length, 1, operationName);
    assert.equal(error.retryable, false, operationName);
    assert.match(error.message, /get_account/, operationName);
  }
});

test("429 (usage limit reached) is permission_denied and never retried, for reads and credit calls", async () => {
  const usageExhausted = { status: 429, body: { errors: [{ code: 429, details: "Usage limit reached" }] } };
  for (const [operationName, args] of [["count_emails", { domain: "example.com" }], ["verify_email", { email: "ada@example.com" }], ["list_leads", {}]]) {
    const { error, calls } = await runHunter(operationName, args, { responses: [usageExhausted, { body: { data: {} } }] });
    assert.equal(calls.length, 1, operationName);
    assert.equal(error?.kind, "permission_denied", operationName);
    assert.equal(error.retryable, false, operationName);
  }
});

test("verify_email: a 202 (still in progress) becomes a pending result with a hint to call again", async () => {
  const pending = await runHunter("verify_email", { email: "ada@example.com" }, { responses: [{ status: 202, body: {} }] });
  if (pending.error) throw pending.error;
  assert.equal(pending.output.data.status, "pending");
  assert.match(pending.output.data.hint, /call verify_email again/);
  const done = await runHunter("verify_email", { email: "ada@example.com" }, { responses: [{ body: { data: { status: "valid", score: 98 } } }] });
  assert.deepEqual(done.output.data, { data: { status: "valid", score: 98 } });
});

test("lead writes as tools need HUNTER_TOOL_ALLOW_LEAD_WRITES=1; nodes are unaffected", async () => {
  const refused = await runHunter("create_lead", { email: "ada@example.com" });
  assert.equal(refused.error?.kind, "permission_denied");
  assert.match(refused.error.message, /HUNTER_TOOL_ALLOW_LEAD_WRITES/);
  assert.equal(refused.calls.length, 0);
  const allowed = await runHunter("create_lead", { email: "ada@example.com" }, { environment: { ...API_KEY, HUNTER_TOOL_ALLOW_LEAD_WRITES: "1" } });
  if (allowed.error) throw allowed.error;
  const fromNode = await runHunter("update_leads_list", { list_id: 7, name: "x" }, { source: "node" });
  if (fromNode.error) throw fromNode.error;
});

test("api_request as a tool only reads free paths: no billed endpoints, no encoded bypasses", async () => {
  for (const path of ["/domain-search?domain=example.com", "/email-verifier?email=a@b.c", "/people/find", "/leads/%2e%2e/email-finder", "/leads/%252e%252e/domain-search", "/accountx"]) {
    const refused = await runHunter("api_request", { path });
    assert.equal(refused.error?.kind, "permission_denied", path);
    assert.equal(refused.calls.length, 0, path);
  }
  for (const path of ["/account", "/email-count?domain=example.com", "/leads/1", "/leads_lists", "/leads-lists/7"]) {
    const allowed = await runHunter("api_request", { path });
    if (allowed.error) throw allowed.error;
    assert.equal(allowed.calls.length, 1, path);
  }
  const fromNode = await runHunter("api_request", { path: "/domain-search?domain=example.com" }, { source: "node" });
  if (fromNode.error) throw fromNode.error;
});

test("Hunter errors: ids and statuses map to kinds (403 rate limit, 429 usage limit)", () => {
  const parseDeclared = createErrorParser(pluginDefinition.restSpec.errors);
  const cases = [
    [400, "invalid_input", { errors: [{ id: "wrong_params", code: 400, details: "You are missing the domain parameter" }] }],
    [403, "rate_limited", { errors: [{ id: "too_many_requests", code: 403, details: "You have reached the rate limit" }] }],
    [403, "rate_limited", { errors: [{ code: 403, details: "Rate limit reached" }] }],
    [403, "permission_denied", { errors: [{ id: "no_discover_access", code: 403, details: "Discover is not available" }] }],
    [429, "permission_denied", { errors: [{ code: 429, details: "Usage limit reached" }] }],
    [451, "permission_denied", { errors: [{ id: "claimed_email", code: 451, details: "The person behind this email has asked us to stop processing" }] }],
  ];
  for (const [status, kind, body] of cases) assert.equal(parseDeclared(status, body).kind, kind, body.errors[0].details);
  assert.equal(parseDeclared(400, cases[0][2]).message, "You are missing the domain parameter (wrong_params)");
});
