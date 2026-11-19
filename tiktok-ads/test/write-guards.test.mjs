import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const ADVERTISER = "7000000000000000001";
// TikTok budgets are in currency units: the cap is USD 50.00.
const toolWrites = { TIKTOK_ADS_TOOL_ALLOW_WRITES: "1", TIKTOK_ADS_TOOL_ADVERTISER_IDS: `${ADVERTISER}, 7000000000000000002`, TIKTOK_ADS_TOOL_MAX_BUDGET: "50" };
const listBody = (list) => ({ body: { code: 0, message: "OK", data: { list, page_info: { page: 1, total_page: 1 } } } });
const okBody = { body: { code: 0, message: "OK", data: {} } };

async function run(operationName, args, { source = "tool", environment = toolWrites, responses = [] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { TIKTOK_ADS_ACCESS_TOKEN: "fake-tiktok-ads-token", ...environment }, { fetchImpl: recordingFetch });
  try {
    return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
  } catch (error) {
    error.calls = recordingFetch.calls;
    throw error;
  }
}

const denied = (fragment) => (error) => {
  assert.equal(error.kind, "permission_denied", error.message);
  assert.ok(error.message.includes(fragment), error.message);
  assert.equal(error.calls.filter((call) => call.method === "POST").length, 0, "no write is sent");
  return true;
};

test("tool writes need the advertiser in TIKTOK_ADS_TOOL_ADVERTISER_IDS", async () => {
  const unset = { TIKTOK_ADS_TOOL_ALLOW_WRITES: "1", TIKTOK_ADS_TOOL_MAX_BUDGET: "50" };
  await assert.rejects(run("set_ad_status", { advertiser_id: ADVERTISER, ad_ids: ["a1"], operation_status: "DISABLE" }, { environment: unset }), denied("TIKTOK_ADS_TOOL_ADVERTISER_IDS"));
  await assert.rejects(run("set_campaign_budget", { advertiser_id: "7999", campaign_id: "c1", budget: 10 }), denied("7999 is not in TIKTOK_ADS_TOOL_ADVERTISER_IDS"));
});

test("disabling checks that every object belongs to the advertiser", async () => {
  await assert.rejects(run("set_campaign_status", { advertiser_id: ADVERTISER, campaign_ids: ["c1", "c2"], operation_status: "DISABLE" }, { responses: [listBody([{ campaign_id: "c1" }])] }), denied("c2"));
  const { calls } = await run("set_campaign_status", { advertiser_id: ADVERTISER, campaign_ids: ["c1"], operation_status: "DISABLE" }, { responses: [listBody([{ campaign_id: "c1" }]), okBody] });
  assert.equal(calls[0].path, "/open_api/v1.3/campaign/get/");
  assert.equal(calls[0].query.advertiser_id, ADVERTISER);
  assert.equal(calls[0].query.filtering, '{"campaign_ids":["c1"]}');
  assert.equal(calls[1].method, "POST");
});

test("a failed read refuses the write", async () => {
  const failure = { body: { code: 40001, message: "No permission", data: {} } };
  await assert.rejects(run("set_ad_group_status", { advertiser_id: ADVERTISER, adgroup_ids: ["g1"], operation_status: "DISABLE" }, { responses: [failure] }), denied("could not be checked"));
});

test("enabling a campaign needs the cap and a finite campaign budget within it", async () => {
  const enable = (list, environment = toolWrites) => run("set_campaign_status", { advertiser_id: ADVERTISER, campaign_ids: ["c1"], operation_status: "ENABLE" }, { environment, responses: [listBody(list), okBody] });
  await assert.rejects(enable([{ campaign_id: "c1", budget_mode: "BUDGET_MODE_DAY", budget: 20 }], { ...toolWrites, TIKTOK_ADS_TOOL_MAX_BUDGET: "0" }), denied("TIKTOK_ADS_TOOL_MAX_BUDGET"));
  // USD 50.50 is 50 cents over the cap.
  await assert.rejects(enable([{ campaign_id: "c1", budget_mode: "BUDGET_MODE_DAY", budget: 50.5 }]), denied("50.5"));
  await assert.rejects(enable([{ campaign_id: "c1", budget_mode: "BUDGET_MODE_INFINITE", budget: 0 }]), denied("no budget"));
  const { calls } = await enable([{ campaign_id: "c1", budget_mode: "BUDGET_MODE_DAY", budget: 50 }]);
  assert.deepEqual(calls[1].json, { advertiser_id: ADVERTISER, campaign_ids: ["c1"], operation_status: "ENABLE" });
});

test("enabling an ad group uses its own budget, else its campaign's (campaign budget optimization)", async () => {
  const enable = (responses) => run("set_ad_group_status", { advertiser_id: ADVERTISER, adgroup_ids: ["g1"], operation_status: "ENABLE" }, { responses });
  await assert.rejects(enable([listBody([{ adgroup_id: "g1", campaign_id: "c1", budget_mode: "BUDGET_MODE_DAY", budget: 70 }])]), denied("70"));
  await assert.rejects(enable([listBody([{ adgroup_id: "g1", campaign_id: "c1", budget_mode: "BUDGET_MODE_INFINITE" }]), listBody([{ campaign_id: "c1", budget_mode: "BUDGET_MODE_DAY", budget: 80 }])]), denied("80"));
  const { calls } = await enable([listBody([{ adgroup_id: "g1", campaign_id: "c1", budget_mode: "BUDGET_MODE_INFINITE" }]), listBody([{ campaign_id: "c1", budget_mode: "BUDGET_MODE_DAY", budget: 40 }]), okBody]);
  assert.equal(calls[1].query.filtering, '{"campaign_ids":["c1"]}');
  assert.equal(calls[2].method, "POST");
});

test("enabling an ad uses its ad group's effective budget", async () => {
  const responses = [listBody([{ ad_id: "a1", adgroup_id: "g1", campaign_id: "c1" }]), listBody([{ adgroup_id: "g1", campaign_id: "c1", budget_mode: "BUDGET_MODE_TOTAL", budget: 500 }])];
  await assert.rejects(run("set_ad_status", { advertiser_id: ADVERTISER, ad_ids: ["a1"], operation_status: "ENABLE" }, { responses }), denied("500"));
});

test("budget changes check ownership of the campaign or ad groups", async () => {
  await assert.rejects(run("set_campaign_budget", { advertiser_id: ADVERTISER, campaign_id: "c1", budget: 10 }, { responses: [listBody([])] }), denied("c1"));
  const { calls } = await run("set_ad_group_budgets", { advertiser_id: ADVERTISER, budget: [{ adgroup_id: "g1", budget: 10 }] }, { responses: [listBody([{ adgroup_id: "g1" }]), okBody] });
  assert.equal(calls[0].query.filtering, '{"adgroup_ids":["g1"]}');
  assert.equal(calls[1].method, "POST");
});

test("budget items have a strict shape and numeric amounts", async () => {
  const node = { source: "node", environment: {} };
  for (const items of [[{ adgroup_id: "g1", budget: "0x10" }], [{ adgroup_id: "g1", budget: 10, extra: 1 }], [{ budget: 10 }], [{ adgroup_id: "", budget: 10 }], [{ adgroup_id: "g1", budget: 0 }], ["g1"]]) {
    await assert.rejects(run("set_ad_group_budgets", { advertiser_id: ADVERTISER, budget: items }, node), (error) => error.kind === "invalid_input" && error.calls.length === 0, JSON.stringify(items));
  }
  await assert.rejects(run("set_ad_group_budgets", { advertiser_id: ADVERTISER, scheduled_budget: [{ adgroup_id: "g1", budget: 10 }] }, node), (error) => error.kind === "invalid_input");
  await assert.rejects(run("set_campaign_budget", { advertiser_id: ADVERTISER, campaign_id: "c1", budget: 0 }, node), (error) => error.kind === "invalid_input");
});

test("download_leads raises the mapped error for a JSON answer and never saves it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tiktok-leads-"));
  try {
    const environment = { TIKTOK_ADS_LEADS_DIR: directory };
    const jsonError = { body: { code: 40201, message: "Task not ready", data: {} } };
    await assert.rejects(run("download_leads", { advertiser_id: ADVERTISER, task_id: "t1" }, { source: "node", environment, responses: [jsonError] }), (error) => error.kind === "api_error" && error.message.includes("Task not ready"));
    const authError = { body: { code: 40105, message: "Access token is incorrect", data: {} } };
    await assert.rejects(run("download_leads", { advertiser_id: ADVERTISER, task_id: "t1" }, { source: "node", environment, responses: [authError] }), (error) => error.kind === "auth_error");
    const mislabelled = { body: '{"code":40105,"message":"Access token is incorrect","data":{}}', headers: { "content-type": "text/csv" } };
    await assert.rejects(run("download_leads", { advertiser_id: ADVERTISER, task_id: "t1" }, { source: "node", environment, responses: [mislabelled] }), (error) => error.kind === "auth_error");
    const unlabelled = { body: ' {"code": 40201, "message": "Task not ready"}', headers: { "content-type": "" } };
    await assert.rejects(run("download_leads", { advertiser_id: ADVERTISER, task_id: "t1" }, { source: "node", environment, responses: [unlabelled] }), (error) => error.kind === "api_error");
    assert.deepEqual(readdirSync(directory), []);
    const csv = { body: "email\nana@example.com\n", headers: { "content-type": "text/csv" } };
    const { result, calls } = await run("download_leads", { advertiser_id: ADVERTISER, task_id: "t1", lead_region: "eu" }, { source: "node", environment, responses: [csv] });
    assert.equal(calls[0].query.task_id, "t1");
    assert.equal(calls[0].headers["x-lead-region"], "eu");
    assert.equal(calls[0].headers["access-token"], "fake-tiktok-ads-token");
    assert.ok(result.data.path.startsWith(directory));
    assert.equal(readdirSync(directory).length, 1);
    await assert.rejects(run("download_leads", { advertiser_id: ADVERTISER, task_id: "t1" }, { environment, responses: [csv] }), (error) => error.kind === "permission_denied" && error.message.includes("TIKTOK_ADS_TOOL_ALLOW_LEADS"));
    await assert.rejects(run("download_leads", { advertiser_id: ADVERTISER, task_id: "t1" }, { source: "node", environment: {}, responses: [csv] }), (error) => error.kind === "invalid_input");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
