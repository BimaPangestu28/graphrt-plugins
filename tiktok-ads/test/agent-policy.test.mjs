import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createBodyErrorDetector } from "../lib/shared/rest-errors.mjs";
import { encodeListArgs } from "../lib/json-query-args.mjs";
import { pluginDefinition } from "../definition.mjs";

const FAKE_TOKEN = "fake-tiktok-ads-token";
const ADVERTISER = "7000000000000000001";
const okBody = (data = {}) => ({ body: { code: 0, message: "OK", request_id: "r1", data } });

async function run(operationName, args, { source = "tool", environment = {}, responses = [okBody()] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { TIKTOK_ADS_ACCESS_TOKEN: FAKE_TOKEN, ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

const writesOn = { TIKTOK_ADS_TOOL_ALLOW_WRITES: "1", TIKTOK_ADS_TOOL_ADVERTISER_IDS: ADVERTISER };
const isDenied = (fragment) => (error) => error.kind === "permission_denied" && error.message.includes(fragment);
const isKind = (kind) => (error) => error.kind === kind;

test("the token is sent in the Access-Token header", async () => {
  const { calls } = await run("list_ads", { advertiser_id: ADVERTISER }, { responses: [okBody({ list: [], page_info: { total_page: 0 } })] });
  assert.equal(calls[0].headers["access-token"], FAKE_TOKEN);
  assert.equal(calls[0].headers.authorization, undefined);
});

test("budget changes as tools need the write opt-in, then TIKTOK_ADS_TOOL_MAX_BUDGET", async () => {
  const args = { advertiser_id: ADVERTISER, campaign_id: "c1", budget: 50.5 };
  await assert.rejects(run("set_campaign_budget", args), isDenied("TIKTOK_ADS_TOOL_ALLOW_WRITES"));
  for (const maxBudget of [undefined, "0", "abc"]) {
    const environment = { ...writesOn, ...(maxBudget === undefined ? {} : { TIKTOK_ADS_TOOL_MAX_BUDGET: maxBudget }) };
    await assert.rejects(run("set_campaign_budget", args, { environment }), isDenied("TIKTOK_ADS_TOOL_MAX_BUDGET"));
  }
});

test("set_campaign_budget as a tool is refused over the cap and sends nothing; within it is sent as is", async () => {
  // Cap USD 50.00; 50.5 (USD 50.50) is over, 50 is at the cap.
  const environment = { ...writesOn, TIKTOK_ADS_TOOL_MAX_BUDGET: "50" };
  await assert.rejects(run("set_campaign_budget", { advertiser_id: ADVERTISER, campaign_id: "c1", budget: 50.5 }, { environment }), isDenied("over TIKTOK_ADS_TOOL_MAX_BUDGET=50"));
  const responses = [okBody({ list: [{ campaign_id: "c1" }] }), okBody()];
  const { calls } = await run("set_campaign_budget", { advertiser_id: ADVERTISER, campaign_id: "c1", budget: 50 }, { environment, responses });
  assert.equal(calls[0].method, "GET", "the campaign is looked up under the advertiser first");
  assert.deepEqual(calls[1].json, { advertiser_id: ADVERTISER, campaign_id: "c1", budget: 50 });
});

test("set_ad_group_budgets as a tool caps the total of every budget in the call", async () => {
  const environment = { ...writesOn, TIKTOK_ADS_TOOL_MAX_BUDGET: "100" };
  const overTotal = { advertiser_id: ADVERTISER, budget: [{ adgroup_id: "g1", budget: 60 }], scheduled_budget: [{ adgroup_id: "g2", scheduled_budget: 41 }] };
  await assert.rejects(run("set_ad_group_budgets", overTotal, { environment }), isDenied("amount 101 is over"));
  await assert.rejects(run("set_ad_group_budgets", { advertiser_id: ADVERTISER }, { environment }), isKind("invalid_input"));
  await assert.rejects(run("set_ad_group_budgets", { advertiser_id: ADVERTISER, budget: [{ adgroup_id: "g1" }] }, { environment }), isKind("invalid_input"));
  const responses = [okBody({ list: [{ adgroup_id: "g1" }, { adgroup_id: "g2" }] }), okBody()];
  const { calls } = await run("set_ad_group_budgets", { advertiser_id: ADVERTISER, budget: [{ adgroup_id: "g1", budget: 60 }, { adgroup_id: "g2", budget: 40 }] }, { environment, responses });
  assert.equal(calls.length, 2);
});

test("workflow nodes change budgets without the cap", async () => {
  const { calls } = await run("set_campaign_budget", { advertiser_id: ADVERTISER, campaign_id: "c1", budget: 5000000 }, { source: "node" });
  assert.equal(calls.length, 1);
});

test("status tools only enable or disable; delete is node only", async () => {
  await assert.rejects(run("set_ad_status", { advertiser_id: ADVERTISER, ad_ids: ["a1"], operation_status: "DELETE" }, { environment: writesOn }), isKind("invalid_input"));
  for (const operationName of ["create_campaign", "create_ad_group", "create_ad", "delete_campaigns", "delete_ad_groups", "delete_ads"]) {
    assert.equal(pluginDefinition.operations.find((operation) => operation.name === operationName).nodeOnly, true, operationName);
  }
});

test("lead reads need TIKTOK_ADS_TOOL_ALLOW_LEADS; forms and fields do not", async () => {
  for (const operationName of ["get_lead", "create_lead_download_task"]) {
    await assert.rejects(run(operationName, { advertiser_id: ADVERTISER, page_id: "p1" }), isDenied("TIKTOK_ADS_TOOL_ALLOW_LEADS"), operationName);
  }
  await assert.rejects(run("download_leads", { advertiser_id: ADVERTISER, task_id: "t1" }), isDenied("TIKTOK_ADS_TOOL_ALLOW_LEADS"));
  const { calls } = await run("get_lead_form_fields", { advertiser_id: ADVERTISER, page_id: "p1" });
  assert.equal(calls.length, 1);
});

test("api_request as a tool only reaches allowlisted read paths", async () => {
  for (const allowedPath of ["/campaign/get/", "/report/integrated/get/?advertiser_id=1", "/pixel/list/"]) {
    const { calls } = await run("api_request", { path: allowedPath });
    assert.equal(calls.length, 1, allowedPath);
  }
  for (const refusedPath of ["/oauth2/advertiser/get/", "/oauth2/access_token/", "/lead/get/", "/page/lead/task/download/", "/bc/get/", "/campaign/get/../../oauth2/advertiser/get/", "/%6Fauth2/advertiser/get/"]) {
    await assert.rejects(run("api_request", { path: refusedPath }), isKind("permission_denied"), refusedPath);
  }
});

test("token fields are removed from tool results, nodes keep them", async () => {
  const responses = [okBody({ list: [{ advertiser_id: ADVERTISER, access_token: "fake-leaked-token" }] })];
  const toolResult = await run("get_advertiser_info", { advertiser_ids: [ADVERTISER] }, { responses });
  assert.equal(JSON.stringify(toolResult.result).includes("fake-leaked-token"), false);
  const nodeResult = await run("get_advertiser_info", { advertiser_ids: [ADVERTISER] }, { source: "node", responses: [okBody({ list: [{ access_token: "fake-leaked-token" }] })] });
  assert.equal(nodeResult.result.data[0].access_token, "fake-leaked-token");
});

test("errors inside HTTP 200 bodies are mapped by code", async () => {
  const failure = (code, message) => ({ body: { code, message, request_id: "r1", data: {} } });
  await assert.rejects(run("list_ads", { advertiser_id: ADVERTISER }, { responses: [failure(40105, "Access token is incorrect or has been revoked.")] }), (error) => error.kind === "auth_error" && error.message.includes("40105"));
  await assert.rejects(run("list_ads", { advertiser_id: ADVERTISER }, { responses: [failure(40102, "Access token has expired")] }), isKind("auth_error"));
  await assert.rejects(run("list_ads", { advertiser_id: ADVERTISER }, { responses: [failure(40001, "No permission")] }), isKind("permission_denied"));
  await assert.rejects(run("list_ads", { advertiser_id: ADVERTISER }, { responses: [failure(40002, "Invalid param")] }), isKind("invalid_input"));
  // Rate limits are retried by the client, so the detector is checked directly.
  const detectBodyError = createBodyErrorDetector(pluginDefinition.restSpec.errors);
  for (const code of [40100, 40016, 40133]) assert.equal(detectBodyError(failure(code, "Too many requests").body).kind, "rate_limited", String(code));
  assert.equal(detectBodyError(okBody().body), null);
});

test("pages follow page_info.total_page", async () => {
  const { result } = await run("list_campaigns", { advertiser_id: ADVERTISER, limit: 1 }, { responses: [okBody({ list: [{ campaign_id: "c1" }], page_info: { page: 1, total_page: 2 } })] });
  assert.equal(result.next_cursor, "2");
  const { calls } = await run("list_campaigns", { advertiser_id: ADVERTISER, limit: 1, cursor: "2" }, { responses: [okBody({ list: [], page_info: { page: 2, total_page: 2 } })] });
  assert.equal(calls[0].query.page, "2");
});

test("list arguments are JSON arrays; graphrt template strings are accepted", async () => {
  assert.deepEqual(encodeListArgs({ fields: ["spend", 7] }, ["fields"]), { fields: '["spend","7"]' });
  assert.throws(() => encodeListArgs({ fields: [""] }, ["fields"]), isKind("invalid_input"));
  const { calls } = await run("get_report", { advertiser_id: ADVERTISER, data_level: "AUCTION_AD", dimensions: '["ad_id"]', query_lifetime: true });
  assert.equal(calls[0].query.dimensions, '["ad_id"]');
});
