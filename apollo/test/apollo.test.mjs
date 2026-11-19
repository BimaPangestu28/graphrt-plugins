import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createErrorParser } from "../lib/shared/rest-errors.mjs";
import { pluginDefinition } from "../definition.mjs";

const API_KEY = { APOLLO_API_KEY: "fake-key" };

async function runApollo(operationName, args, { environment = API_KEY, source = "tool", responses = [{ body: {} }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("manifest: sequence enrolment and webhook enrichment are node only; key and opt-ins are the env", () => {
  const manifest = buildManifest(pluginDefinition);
  const toolNames = manifest.tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["add_contacts_to_sequence", "enrich_person_with_callback"]) assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
  for (const tool of manifest.tools) assert.equal(Object.hasOwn(tool.parameters.properties, "webhook_url"), false, tool.name);
  assert.deepEqual(manifest.permissions.env.sort(), ["APOLLO_API_KEY", "APOLLO_TOOL_ALLOW_BULK_ENRICHMENT", "APOLLO_TOOL_ALLOW_CONTACT_WRITES"]);
  const sequenceNode = pluginDefinition.operations.find((operation) => operation.name === "add_contacts_to_sequence");
  assert.equal(Object.hasOwn(sequenceNode.parameters.properties, "emailer_campaign_id"), false);
});

test("the key goes in the x-api-key header", async () => {
  const { calls } = await runApollo("list_contact_stages", {});
  assert.equal(calls[0].headers["x-api-key"], "fake-key");
  assert.equal(calls[0].url.includes("fake-key"), false);
});

test("credit-consuming calls are never retried after a 5xx and say how to check", async () => {
  for (const [operationName, args] of [["enrich_person", { email: "ada@example.com" }], ["enrich_organization", { domain: "example.com" }], ["search_organizations", { q_organization_name: "x" }]]) {
    const { error, calls } = await runApollo(operationName, args, { responses: [{ status: 502, body: {} }, { body: {} }] });
    assert.equal(calls.length, 1, operationName);
    assert.equal(error.retryable, false, operationName);
    assert.match(error.message, /credit usage/, operationName);
  }
});

test("searches stop paging at Apollo's 500-page display limit", async () => {
  const fullPage = { people: Array.from({ length: 2 }, (_, index) => ({ id: `p${index}` })) };
  const middle = await runApollo("search_people", { person_titles: ["cto"], limit: 2, cursor: "499" }, { responses: [{ body: fullPage }] });
  assert.equal(middle.output.next_cursor, "500");
  const last = await runApollo("search_people", { person_titles: ["cto"], limit: 2, cursor: "500" }, { responses: [{ body: fullPage }] });
  assert.equal(last.output.next_cursor, null);
  const beyond = await runApollo("search_people", { person_titles: ["cto"], cursor: "501" });
  assert.equal(beyond.error?.kind, "invalid_input");
  assert.equal(beyond.calls.length, 0);
});

test("free searches are retried after a 5xx", async () => {
  const { error, calls } = await runApollo("search_people", { person_titles: ["cto"] }, { responses: [{ status: 503, body: {} }, { body: { people: [] } }] });
  if (error) throw error;
  assert.equal(calls.length, 2);
});

test("bulk enrichment and contact writes as tools need their opt-ins", async () => {
  const cases = [
    ["bulk_enrich_people", { details: [{ email: "ada@example.com" }] }, "APOLLO_TOOL_ALLOW_BULK_ENRICHMENT"],
    ["bulk_enrich_organizations", { details: [{ domain: "example.com" }] }, "APOLLO_TOOL_ALLOW_BULK_ENRICHMENT"],
    ["create_contact", { first_name: "Ada" }, "APOLLO_TOOL_ALLOW_CONTACT_WRITES"],
    ["update_contact", { contact_id: "c1", first_name: "Ada" }, "APOLLO_TOOL_ALLOW_CONTACT_WRITES"],
  ];
  for (const [operationName, args, optInEnv] of cases) {
    const refused = await runApollo(operationName, args);
    assert.equal(refused.error?.kind, "permission_denied", operationName);
    assert.match(refused.error.message, new RegExp(optInEnv));
    assert.equal(refused.calls.length, 0);
    const allowed = await runApollo(operationName, args, { environment: { ...API_KEY, [optInEnv]: "1" } });
    if (allowed.error) throw allowed.error;
  }
});

test("bulk enrichment takes at most 10 records", async () => {
  const { error, calls } = await runApollo("bulk_enrich_people", { details: Array(11).fill({ email: "a@example.com" }) }, { source: "node" });
  assert.equal(error?.kind, "invalid_input");
  assert.equal(calls.length, 0);
});

test("add_contacts_to_sequence: sequence_id fills emailer_campaign_id (a caller's value is overridden) and contacts are required", async () => {
  const sent = await runApollo("add_contacts_to_sequence", { sequence_id: "e1", contact_ids: ["c1"], send_email_from_email_account_id: "m1", emailer_campaign_id: "other" }, { source: "node" });
  if (sent.error) throw sent.error;
  assert.equal(sent.calls[0].query.emailer_campaign_id, "e1");
  const empty = await runApollo("add_contacts_to_sequence", { sequence_id: "e1", send_email_from_email_account_id: "m1" }, { source: "node" });
  assert.equal(empty.error?.kind, "invalid_input");
  assert.equal(empty.calls.length, 0);
  const asTool = await runApollo("add_contacts_to_sequence", { sequence_id: "e1", contact_ids: ["c1"], send_email_from_email_account_id: "m1" });
  assert.equal(asTool.error?.kind, "invalid_input", "node only: unknown to tools");
});

test("api_request as a tool only reads CRM paths: no billed GETs, no encoded bypasses", async () => {
  for (const path of ["/organizations/enrich?domain=example.com", "/contacts/%2e%2e/organizations/enrich", "/contacts/%252e%252e/organizations/enrich", "/users/../organizations/enrich", "/mixed_people/api_search"]) {
    const refused = await runApollo("api_request", { path });
    assert.equal(refused.error?.kind, "permission_denied", path);
    assert.equal(refused.calls.length, 0, path);
  }
  for (const path of ["/contacts/c1", "/auth/health", "/email_accounts"]) {
    const allowed = await runApollo("api_request", { path });
    if (allowed.error) throw allowed.error;
  }
});

test("Apollo errors: error_details codes, legacy error strings, 401 text, 403 and 429", () => {
  const parseDeclared = createErrorParser(pluginDefinition.restSpec.errors);
  const cases = [
    [403, "permission_denied", { error: "This API key is not authorized to access api/v1/contacts", error_code: "API_INACCESSIBLE", error_details: { code: "AUTH.AUTHORIZATION.ENDPOINT_ACCESS_DENIED", message: "Endpoint access denied" } }],
    [429, "rate_limited", { message: "Rate limit exceeded", error_details: { code: "USAGE.RATE_LIMIT.API_RATE_LIMIT_EXCEEDED", message: "Too many requests this minute" } }],
    [400, "invalid_input", { error_details: { code: "SEARCH.VALIDATION.WEBHOOK_URL_REQUIRED", message: "webhook_url is required" } }],
    [422, "invalid_input", { error: "Invalid parameters" }],
    [401, "auth_error", { error_details: { code: "AUTH.AUTHENTICATION.API_KEY_INVALID", message: "This API key is not valid." } }],
  ];
  for (const [status, kind, body] of cases) assert.equal(parseDeclared(status, body).kind ?? "", kind, JSON.stringify(body));
  assert.equal(parseDeclared(422, { error: "Invalid parameters" }).message, "Invalid parameters");
});
