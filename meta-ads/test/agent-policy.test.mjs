import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createErrorParser } from "../lib/shared/rest-errors.mjs";
import { normalizeAdAccountId } from "../lib/ad-account-id.mjs";
import { containsLeadData, mentionsSecret } from "../lib/meta-tool-guards.mjs";
import { pluginDefinition } from "../definition.mjs";

const FAKE_TOKEN = "fake-meta-ads-token";

async function run(operationName, args, { source = "tool", environment = {}, responses = [{ body: { success: true } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { META_ADS_ACCESS_TOKEN: FAKE_TOKEN, ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

const writesOn = { META_ADS_TOOL_ALLOW_WRITES: "1" };
const isDenied = (fragment) => (error) => error.kind === "permission_denied" && error.message.includes(fragment);

test("set_budget as a tool needs the write opt-in first, and the refusal names it", async () => {
  await assert.rejects(run("set_budget", { object_id: "120200001", daily_budget: 2000 }), isDenied("META_ADS_TOOL_ALLOW_WRITES"));
});

test("set_budget as a tool is refused while META_ADS_TOOL_MAX_DAILY_BUDGET is unset or 0, and sends nothing", async () => {
  for (const maxBudget of [undefined, "0", "not-a-number"]) {
    const environment = { ...writesOn, ...(maxBudget === undefined ? {} : { META_ADS_TOOL_MAX_DAILY_BUDGET: maxBudget }) };
    await assert.rejects(run("set_budget", { object_id: "120200001", daily_budget: 2000 }, { environment }), isDenied("META_ADS_TOOL_MAX_DAILY_BUDGET"));
  }
});

test("set_budget as a tool is refused over the cap, for daily and lifetime budgets", async () => {
  // Cap 5000 minor units = USD 50.00; 5001 is one cent over.
  const environment = { ...writesOn, META_ADS_TOOL_MAX_DAILY_BUDGET: "5000" };
  await assert.rejects(run("set_budget", { object_id: "120200001", daily_budget: 5001 }, { environment }), isDenied("over META_ADS_TOOL_MAX_DAILY_BUDGET=5000"));
  await assert.rejects(run("set_budget", { object_id: "120200001", lifetime_budget: 900000 }, { environment }), isDenied("over META_ADS_TOOL_MAX_DAILY_BUDGET=5000"));
  await assert.rejects(run("set_budget", { object_id: "120200001" }, { environment }), isDenied("could not be read"));
});

test("set_budget as a tool within the cap sends the budget in minor units", async () => {
  const environment = { ...writesOn, META_ADS_TOOL_MAX_DAILY_BUDGET: "5000" };
  const responses = [{ body: { id: "120200001", account_id: "111" } }, { body: { success: true } }];
  const { calls } = await run("set_budget", { object_id: "120200001", object_type: "campaign", daily_budget: 5000 }, { environment: { ...environment, META_ADS_TOOL_ACCOUNT_IDS: "111" }, responses });
  assert.equal(calls.length, 2, "the account is read first");
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(calls[1].form, { daily_budget: "5000" });
});

test("workflow nodes change budgets without the cap", async () => {
  const { calls } = await run("set_budget", { object_id: "120200001", daily_budget: 99999999 }, { source: "node" });
  assert.equal(calls.length, 1);
});

test("set_status as a tool needs META_ADS_TOOL_ALLOW_WRITES and only pauses or activates", async () => {
  await assert.rejects(run("set_status", { object_id: "120200001", status: "PAUSED" }), isDenied("META_ADS_TOOL_ALLOW_WRITES"));
  await assert.rejects(run("set_status", { object_id: "120200001", status: "DELETED" }, { environment: writesOn }), (error) => error.kind === "invalid_input");
  const responses = [{ body: { id: "120200001", account_id: "111" } }, { body: { success: true } }];
  const { calls } = await run("set_status", { object_id: "120200001", object_type: "ad_set", status: "PAUSED" }, { environment: { ...writesOn, META_ADS_TOOL_ACCOUNT_IDS: "111" }, responses });
  assert.deepEqual(calls[1].form, { status: "PAUSED" });
});

test("creates and deletes are not agent tools", () => {
  for (const operationName of ["create_campaign", "create_ad_set", "create_ad_creative", "create_ad", "delete_object"]) {
    assert.equal(pluginDefinition.operations.find((operation) => operation.name === operationName).nodeOnly, true, operationName);
  }
});

test("list_leads as a tool needs META_ADS_TOOL_ALLOW_LEADS", async () => {
  await assert.rejects(run("list_leads", { lead_source_id: "2000001" }), isDenied("META_ADS_TOOL_ALLOW_LEADS"));
  const responses = [{ body: { data: [{ id: "l1", field_data: [{ name: "email", values: ["ana@example.com"] }] }] } }];
  const { result } = await run("list_leads", { lead_source_id: "2000001" }, { environment: { META_ADS_TOOL_ALLOW_LEADS: "1" }, responses });
  assert.equal(result.data[0].field_data[0].values[0], "ana@example.com");
});

test("lead answers reached any other way are refused for tools without the leads opt-in", async () => {
  const leadBody = { id: "3000001", field_data: [{ name: "phone_number", values: ["+6281"] }] };
  await assert.rejects(run("api_request", { path: "/3000001" }, { responses: [{ body: leadBody }] }), isDenied("META_ADS_TOOL_ALLOW_LEADS"));
  await assert.rejects(run("get_ad", { ad_id: "3000001", fields: "leads{field_data}" }, { responses: [{ body: { leads: { data: [leadBody] } } }] }), isDenied("META_ADS_TOOL_ALLOW_LEADS"));
  const optedIn = await run("api_request", { path: "/3000001" }, { environment: { META_ADS_TOOL_ALLOW_LEADS: "1" }, responses: [{ body: leadBody }] });
  assert.equal(optedIn.result.data.id, "3000001");
  const node = await run("api_request", { path: "/3000001" }, { source: "node", responses: [{ body: leadBody }] });
  assert.equal(node.result.data.id, "3000001");
});

test("api_request as a tool only reaches ad read paths", async () => {
  for (const allowedPath of ["/me/adaccounts", "/act_1/campaigns", "/act_1/insights", "/120200001", "/120200001/adsets", "/120200001/insights?level=ad"]) {
    const { calls } = await run("api_request", { path: allowedPath }, { responses: [{ body: { data: [] } }] });
    assert.equal(calls.length, 1, allowedPath);
  }
  for (const refusedPath of ["/me/accounts", "/me", "/1000001/accounts", "/act_1/users", "/oauth/access_token", "/120200001/../me/accounts", "/120200001/%2E%2E/me/accounts", "/1000001/subscribed_apps"]) {
    await assert.rejects(run("api_request", { path: refusedPath }), (error) => error.kind === "permission_denied", refusedPath);
  }
});

test("api_request as a tool never asks for tokens or secrets", async () => {
  const refusedCalls = [
    { path: "/1000001", query: { fields: "access_token" } },
    { path: "/1000001?fields=access_token" },
    { path: "/1000001?fields=%61ccess_%74oken" },
    { path: "/act_1/campaigns", query: { fields: "account{business{owned_pages{access_token}}}" } },
    { path: "/1000001", query: { fields: "name", appsecret_proof: "x" } },
  ];
  for (const args of refusedCalls) await assert.rejects(run("api_request", args), isDenied("secret"), JSON.stringify(args));
  const { calls } = await run("api_request", { path: "/me/accounts" }, { source: "node", responses: [{ body: { data: [] } }] });
  assert.equal(calls.length, 1, "workflow nodes are unaffected");
});

test("api_request as a tool cannot reach the leads edge without the opt-in", async () => {
  await assert.rejects(run("api_request", { path: "/2000001/leads" }), (error) => error.kind === "permission_denied");
});

test("access_token fields (Page tokens) are removed from tool results, nodes keep them", async () => {
  const body = { data: [{ id: "act_1", name: "Shop", business: { id: "9", access_token: "fake-page-token" } }], paging: {} };
  const toolResult = await run("list_ad_accounts", {}, { responses: [{ body }] });
  assert.equal(JSON.stringify(toolResult.result.data).includes("fake-page-token"), false);
  assert.equal(toolResult.result.data[0].name, "Shop");
  const nodeResult = await run("list_ad_accounts", {}, { source: "node", responses: [{ body }] });
  assert.equal(nodeResult.result.data[0].business.access_token, "fake-page-token");
});

test("a bare numeric ad account id gets the act_ prefix", async () => {
  assert.equal(normalizeAdAccountId("1234567890"), "act_1234567890");
  assert.equal(normalizeAdAccountId(" act_12 "), " act_12 ");
  const { calls } = await run("list_campaigns", { ad_account_id: "1234567890" }, { responses: [{ body: { data: [] } }] });
  assert.equal(calls[0].path, "/v27.0/act_1234567890/campaigns");
});

test("list params are sent as JSON arrays; graphrt template strings are accepted", async () => {
  const { calls } = await run("list_ads", { ad_account_id: "act_1", effective_status: '["ACTIVE"]' }, { responses: [{ body: { data: [] } }] });
  assert.equal(calls[0].query.effective_status, '["ACTIVE"]');
});

test("META_GRAPH_VERSION selects the version and is validated", async () => {
  const { calls } = await run("get_campaign", { campaign_id: "1" }, { environment: { META_GRAPH_VERSION: "v26.0" }, responses: [{ body: { id: "1" } }] });
  assert.equal(calls[0].path, "/v26.0/1");
  await assert.rejects(run("get_campaign", { campaign_id: "1" }, { environment: { META_GRAPH_VERSION: "latest" } }), (error) => error.kind === "invalid_input");
});

test("Meta throttling codes are rate_limited, token errors auth_error", async () => {
  const parseError = createErrorParser(pluginDefinition.restSpec.errors);
  for (const code of [4, 17, 32, 613, 80000, 80004, 80014]) {
    assert.equal(parseError(400, { error: { message: "limit", type: "OAuthException", code, fbtrace_id: "f" } }).kind, "rate_limited", String(code));
  }
  assert.equal(parseError(400, { error: { message: "bad field", code: 100 } }).kind, "invalid_input");
  await assert.rejects(run("get_campaign", { campaign_id: "1" }, { responses: [{ status: 401, body: { error: { message: "Invalid OAuth access token", code: 190 } } }] }), (error) => error.kind === "auth_error");
  await assert.rejects(run("get_campaign", { campaign_id: "1" }, { responses: [{ status: 403, body: { error: { message: "no ads_read", code: 200 } } }] }), (error) => error.kind === "permission_denied");
});

test("guard helpers", () => {
  assert.equal(mentionsSecret({ path: "/act_1/campaigns", query: { fields: "id,name" } }), false);
  assert.equal(mentionsSecret({ path: "/1", query: { fields: "ACCESS_TOKEN" } }), true);
  assert.equal(containsLeadData({ data: [{ leads: { data: [{ field_data: [] }] } }] }), true);
  assert.equal(containsLeadData({ data: [{ name: "form" }] }), false);
});
