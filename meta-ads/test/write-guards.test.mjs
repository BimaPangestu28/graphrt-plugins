import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const FAKE_TOKEN = "fake-meta-ads-token";
// Budgets are in minor units: 5000 = USD 50.00. The cap below is USD 50.00.
const toolWrites = { META_ADS_TOOL_ALLOW_WRITES: "1", META_ADS_TOOL_ACCOUNT_IDS: "act_111,222", META_ADS_TOOL_MAX_DAILY_BUDGET: "5000" };

async function run(operationName, args, { source = "tool", environment = toolWrites, responses = [] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { META_ADS_ACCESS_TOKEN: FAKE_TOKEN, ...environment }, { fetchImpl: recordingFetch });
  try {
    return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
  } catch (error) {
    error.calls = recordingFetch.calls;
    throw error;
  }
}

const denied = (fragment, expectedCalls) => (error) => {
  assert.equal(error.kind, "permission_denied", error.message);
  assert.ok(error.message.includes(fragment), error.message);
  if (expectedCalls !== undefined) assert.equal(error.calls.filter((call) => call.method !== "GET").length, expectedCalls, "no write is sent");
  return true;
};
const success = { body: { success: true } };

test("tool writes need META_ADS_TOOL_ACCOUNT_IDS", async () => {
  const environment = { META_ADS_TOOL_ALLOW_WRITES: "1", META_ADS_TOOL_MAX_DAILY_BUDGET: "5000" };
  await assert.rejects(run("set_status", { object_id: "1", object_type: "campaign", status: "PAUSED" }, { environment }), denied("META_ADS_TOOL_ACCOUNT_IDS", 0));
  await assert.rejects(run("set_budget", { object_id: "1", object_type: "campaign", daily_budget: 100 }, { environment }), denied("META_ADS_TOOL_ACCOUNT_IDS", 0));
});

test("tool writes need object_type", async () => {
  await assert.rejects(run("set_status", { object_id: "1", status: "PAUSED" }), (error) => error.kind === "invalid_input" && error.message.includes("object_type"));
});

test("pausing an object of a listed account reads its account first, then writes", async () => {
  const { calls } = await run("set_status", { object_id: "120200001", object_type: "ad", status: "PAUSED" }, { responses: [{ body: { id: "120200001", account_id: "222" } }, success] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].path, "/v27.0/120200001");
  assert.match(calls[0].query.fields, /account_id/);
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(calls[1].form, { status: "PAUSED" });
});

test("writes to an object of another account are refused", async () => {
  await assert.rejects(run("set_status", { object_id: "120200001", object_type: "campaign", status: "PAUSED" }, { responses: [{ body: { id: "120200001", account_id: "999" } }] }), denied("not in META_ADS_TOOL_ACCOUNT_IDS", 0));
  await assert.rejects(run("set_budget", { object_id: "120200001", object_type: "ad_set", daily_budget: 100 }, { responses: [{ body: { id: "120200001", account_id: "999" } }] }), denied("not in META_ADS_TOOL_ACCOUNT_IDS", 0));
  await assert.rejects(run("set_budget", { object_id: "120200001", object_type: "ad", daily_budget: 100 }), (error) => error.kind === "invalid_input");
});

test("a failed account or budget read refuses the write", async () => {
  const graphError = { status: 400, body: { error: { message: "nonexisting field (adset)", code: 100 } } };
  await assert.rejects(run("set_status", { object_id: "120200001", object_type: "campaign", status: "ACTIVE" }, { responses: [graphError] }), denied("could not be checked", 0));
  await assert.rejects(run("set_status", { object_id: "120200001", object_type: "campaign", status: "PAUSED" }, { responses: [{ body: { id: "120200001" } }] }), denied("not in META_ADS_TOOL_ACCOUNT_IDS", 0));
});

test("activating needs the cap and a budget within it", async () => {
  const activate = (objectType, body, environment = toolWrites) => run("set_status", { object_id: "120200001", object_type: objectType, status: "ACTIVE" }, { environment, responses: [{ body }, success] });
  await assert.rejects(activate("campaign", { account_id: "111", daily_budget: "2000" }, { ...toolWrites, META_ADS_TOOL_MAX_DAILY_BUDGET: "" }), denied("META_ADS_TOOL_MAX_DAILY_BUDGET", 0));
  // Campaign with a USD 50.01 daily budget: one cent over the cap.
  await assert.rejects(activate("campaign", { account_id: "111", daily_budget: "5001" }), denied("5001", 0));
  await assert.rejects(activate("campaign", { account_id: "111", daily_budget: "0", lifetime_budget: "900000" }), denied("900000", 0));
  await assert.rejects(activate("campaign", { account_id: "111" }), denied("no budget", 0));
  // Ad set without its own budget under a campaign budget (CBO) of USD 60.00.
  await assert.rejects(activate("ad_set", { account_id: "111", daily_budget: "0", campaign: { daily_budget: "6000", id: "9" } }), denied("6000", 0));
  // Ad: its ad set's budget counts.
  await assert.rejects(activate("ad", { account_id: "111", adset: { daily_budget: "7000", id: "8" }, campaign: { id: "9" } }), denied("7000", 0));
  const allowed = await activate("ad", { account_id: "111", adset: { daily_budget: "0", id: "8" }, campaign: { daily_budget: "5000", id: "9" } });
  assert.equal(allowed.calls.length, 2);
  assert.match(allowed.calls[0].query.fields, /adset\{daily_budget,lifetime_budget\}/);
  assert.deepEqual(allowed.calls[1].form, { status: "ACTIVE" });
});

test("workflow nodes are not checked", async () => {
  const { calls } = await run("set_status", { object_id: "120200001", status: "ACTIVE" }, { source: "node", environment: {}, responses: [success] });
  assert.equal(calls.length, 1);
});
