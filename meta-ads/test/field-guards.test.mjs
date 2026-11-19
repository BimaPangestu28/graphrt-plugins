import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

async function run(operationName, args, { source = "tool", environment = {}, responses = [{ body: { data: [] } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { META_ADS_ACCESS_TOKEN: "fake-meta-ads-token", ...environment }, { fetchImpl: recordingFetch });
  try {
    return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
  } catch (error) {
    error.calls = recordingFetch.calls;
    throw error;
  }
}

const refusedBeforeSending = (kind) => (error) => error.kind === kind && error.calls.length === 0;

test("field aliasing (.as) is refused for tools on every fields argument", async () => {
  const probes = [
    ["get_ad", { ad_id: "120200003", fields: "leads.as(x){field_data.as(answers)}" }],
    ["get_campaign", { campaign_id: "1000001", fields: "access_token.as(t)" }],
    ["get_ad_account", { ad_account_id: "act_1", fields: "name.AS (n)" }],
    ["list_campaigns", { ad_account_id: "act_1", fields: "id,name.as(n)" }],
    ["api_request", { path: "/1000001", query: { fields: "name.as(n)" } }],
    ["api_request", { path: "/1000001?fields=name.as%28n%29" }],
  ];
  for (const [operationName, args] of probes) {
    await assert.rejects(run(operationName, args, { environment: { META_ADS_TOOL_ALLOW_LEADS: "1" } }), refusedBeforeSending("permission_denied"), JSON.stringify(args));
  }
});

test("token and secret words are refused in every fields argument", async () => {
  for (const fields of ["access_token", "id,ACCESS_TOKEN", "page_token", "business{owned_pages{access_token}}", "app_secret"]) {
    await assert.rejects(run("get_campaign", { campaign_id: "1000001", fields }), refusedBeforeSending("permission_denied"), fields);
  }
});

test("leads and field_data in fields need the leads opt-in", async () => {
  for (const [operationName, args] of [
    ["get_ad", { ad_id: "120200003", fields: "leads{id}" }],
    ["get_ad", { ad_id: "120200003", fields: "id,field_data" }],
    ["list_ads", { ad_account_id: "act_1", fields: "id,leads.limit(5)" }],
    ["api_request", { path: "/120200003", query: { fields: "leads" } }],
  ]) {
    await assert.rejects(run(operationName, args), refusedBeforeSending("permission_denied"), JSON.stringify(args));
  }
  const optedIn = await run("get_ad", { ad_id: "120200003", fields: "leads{id}" }, { environment: { META_ADS_TOOL_ALLOW_LEADS: "1" }, responses: [{ body: { id: "120200003" } }] });
  assert.equal(optedIn.calls.length, 1);
  const formsCount = await run("list_lead_forms", { page_id: "1000001", fields: "id,name,leads_count" });
  assert.equal(formsCount.calls.length, 1, "leads_count is not the leads edge");
});

test("ids are validated for tools: ad accounts act_<digits> or digits, others digits or <digits>_<digits>", async () => {
  const probes = [
    ["list_campaigns", { ad_account_id: "me" }],
    ["list_campaigns", { ad_account_id: "act_me" }],
    ["get_ad_account", { ad_account_id: "act_1/users" }],
    ["get_campaign", { campaign_id: "me" }],
    ["get_ad", { ad_id: "1000001_abc" }],
    ["list_lead_forms", { page_id: "me" }],
    ["get_insights", { object_id: "me" }],
    ["get_insights_report_rows", { report_run_id: "x1" }],
  ];
  for (const [operationName, args] of probes) {
    await assert.rejects(run(operationName, args), refusedBeforeSending("invalid_input"), JSON.stringify(args));
  }
  for (const [operationName, args] of [
    ["list_campaigns", { ad_account_id: "act_1" }],
    ["list_campaigns", { ad_account_id: "1" }],
    ["get_insights", { object_id: "act_1" }],
    ["get_ad", { ad_id: "1000001_2000001" }],
  ]) {
    const { calls } = await run(operationName, args, { responses: [{ body: { data: [] } }] });
    assert.equal(calls.length, 1, JSON.stringify(args));
  }
});

test("workflow nodes are not limited by the field and id checks", async () => {
  const { calls } = await run("get_campaign", { campaign_id: "me", fields: "name.as(n)" }, { source: "node", responses: [{ body: {} }] });
  assert.equal(calls.length, 1);
});
