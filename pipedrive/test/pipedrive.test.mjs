import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { buildPipedriveBaseUrl, pluginDefinition } from "../definition.mjs";

const TOKEN = { PIPEDRIVE_API_TOKEN: "pd-token-1234567890" };

async function runPipedrive(operationName, args, { environment = TOKEN, source = "tool", responses = [{ body: { success: true, data: [] } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("industry is an integer option id and pinned flags are 0 or 1; other values are refused before any request", async () => {
  for (const [operationName, args] of [
    ["update_organization", { organization_id: 7, industry: "Retail" }],
    ["create_note", { content: "x", deal_id: 11, pinned_to_deal_flag: 2 }],
  ]) {
    const { error, calls } = await runPipedrive(operationName, args, { source: "node" });
    assert.equal(error?.kind, "invalid_input", operationName);
    assert.equal(calls.length, 0, operationName);
  }
});

test("manifest: deletes are node only, the token and domain env are declared", () => {
  const manifest = buildManifest(pluginDefinition);
  const toolNames = manifest.tools.map((tool) => tool.name);
  for (const deleteName of ["delete_person", "delete_organization", "delete_deal", "delete_activity", "delete_note"]) {
    assert.equal(toolNames.includes(deleteName), false, deleteName);
    assert.equal(manifest.nodes.some((node) => node.kind.endsWith(`.${deleteName}`)), true, deleteName);
  }
  assert.deepEqual(manifest.permissions.env.sort(), ["PIPEDRIVE_API_TOKEN", "PIPEDRIVE_COMPANY_DOMAIN", "PIPEDRIVE_TOOL_API_EXTRA_PATHS", "PIPEDRIVE_TOOL_TOKEN_SOURCE"]);
});

test("PIPEDRIVE_COMPANY_DOMAIN picks the company host; bad values are refused before any request", async () => {
  assert.equal(buildPipedriveBaseUrl({}), "https://api.pipedrive.com/api");
  assert.equal(buildPipedriveBaseUrl({ PIPEDRIVE_COMPANY_DOMAIN: "Acme" }), "https://acme.pipedrive.com/api");
  assert.equal(buildPipedriveBaseUrl({ PIPEDRIVE_COMPANY_DOMAIN: "acme.pipedrive.com" }), "https://acme.pipedrive.com/api");
  for (const badDomain of ["evil.example", "acme.pipedrive.com.evil.example", "a/b", "-acme"]) {
    const { error, calls } = await runPipedrive("list_deals", {}, { environment: { ...TOKEN, PIPEDRIVE_COMPANY_DOMAIN: badDomain } });
    assert.equal(error?.kind, "invalid_input", badDomain);
    assert.equal(calls.length, 0);
  }
  const { calls } = await runPipedrive("get_deal", { deal_id: 3 }, { environment: { ...TOKEN, PIPEDRIVE_COMPANY_DOMAIN: "acme" }, responses: [{ body: { success: true, data: { id: 3 } } }] });
  assert.equal(calls[0].url, "https://acme.pipedrive.com/api/v2/deals/3");
});

test("the token goes in the x-api-token header, never in the URL", async () => {
  const { calls } = await runPipedrive("list_persons", {});
  assert.equal(calls[0].headers["x-api-token"], TOKEN.PIPEDRIVE_API_TOKEN);
  assert.equal(calls[0].url.includes(TOKEN.PIPEDRIVE_API_TOKEN), false);
});

test("Pipedrive's 401 body becomes an auth_error with its message", async () => {
  const { error } = await runPipedrive("list_persons", {}, { responses: [{ status: 401, body: { success: false, error: "unauthorized access", errorCode: 401, error_info: "Please check developers.pipedrive.com" } }] });
  assert.equal(error.kind, "auth_error");
  assert.match(error.message, /unauthorized access/);
});

test("v2 lists return next_cursor from additional_data; v1 notes page by start offset", async () => {
  const v2 = await runPipedrive("list_deals", { limit: 2 }, { responses: [{ body: { success: true, data: [{ id: 1 }, { id: 2 }], additional_data: { next_cursor: "eyJpZCI6Mn0" } } }] });
  assert.equal(v2.output.next_cursor, "eyJpZCI6Mn0");
  const notes = await runPipedrive("list_notes", { limit: 2 }, { responses: [{ body: { success: true, data: [{ id: 1 }, { id: 2 }] } }] });
  assert.equal(Number(notes.output.next_cursor), 2);
  const secondPage = await runPipedrive("list_notes", { limit: 2, cursor: "2" }, { responses: [{ body: { success: true, data: [{ id: 3 }] } }] });
  assert.equal(secondPage.calls[0].url.includes("start=2"), true);
  assert.equal(secondPage.output.next_cursor, null);
});

test("search returns data.items", async () => {
  const { output } = await runPipedrive("search_persons", { term: "ada" }, { responses: [{ body: { success: true, data: { items: [{ result_score: 1, item: { id: 5 } }] } } }] });
  assert.deepEqual(output.data, [{ result_score: 1, item: { id: 5 } }]);
});

for (const refusedPath of ["/v1/webhooks", "/v1/userConnections", "/v1/userSettings", "/v1/deals/../webhooks", "/v1/deals/%2e%2e/webhooks", "/v1/deals%2F..%2Fwebhooks", "/v1\\webhooks", "/v1/Webhooks", "/v1/billing/subscriptions/addons"]) {
  test(`agent api_request cannot reach ${refusedPath}`, async () => {
    const { error, calls } = await runPipedrive("api_request", { path: refusedPath });
    assert.equal(error?.kind, "permission_denied");
    assert.equal(calls.length, 0);
  });
}

for (const allowedPath of ["/v1/dealFields", "/v2/deals/11/followers", "/v1/leads", "/v1/itemSearch?term=ada", "/v2/products"]) {
  test(`agent api_request may read ${allowedPath}`, async () => {
    const { error, calls } = await runPipedrive("api_request", { path: allowedPath });
    if (error) throw error;
    assert.equal(calls.length, 1);
  });
}

test("workflow nodes may use api_request on any path; PIPEDRIVE_TOOL_API_EXTRA_PATHS widens the tool list", async () => {
  const node = await runPipedrive("api_request", { path: "/v1/webhooks" }, { source: "node" });
  if (node.error) throw node.error;
  const widened = await runPipedrive("api_request", { path: "/v1/goals/find" }, { environment: { ...TOKEN, PIPEDRIVE_TOOL_API_EXTRA_PATHS: "/v1/goals/*" } });
  if (widened.error) throw widened.error;
  assert.equal(widened.calls.length, 1);
});

test("ids must be positive integers before any request", async () => {
  for (const badId of [0, -1, "abc"]) {
    const { error, calls } = await runPipedrive("get_person", { person_id: badId });
    assert.equal(error?.kind, "invalid_input", String(badId));
    assert.equal(calls.length, 0);
  }
});
