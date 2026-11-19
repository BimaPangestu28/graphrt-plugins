import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { findSensitiveResources } from "../lib/google-ads-guards.mjs";
import { pluginDefinition } from "../definition.mjs";

const CUSTOMER = "1234567890";
const API = "https://googleads.googleapis.com/v26";
// Micros: 25000000 = 25.00 in the account currency; the cap is 25.00.
const toolWrites = { GOOGLE_ADS_TOOL_ALLOW_WRITES: "1", GOOGLE_ADS_TOOL_CUSTOMER_IDS: "123-456-7890, 1111111111", GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS: "25000000" };
const searchRows = (results) => ({ body: { results } });
const mutated = { body: { results: [{ resourceName: "x" }] } };

async function run(operationName, args, { source = "tool", environment = toolWrites, responses = [] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { GOOGLE_ACCESS_TOKEN: "fake-google-access-token", ...environment }, { fetchImpl: recordingFetch });
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
  assert.equal(error.calls.filter((call) => call.url.includes(":mutate")).length, 0, "no mutate is sent");
  return true;
};

test("tool writes need the customer in GOOGLE_ADS_TOOL_CUSTOMER_IDS", async () => {
  const unset = { GOOGLE_ADS_TOOL_ALLOW_WRITES: "1", GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS: "25000000" };
  await assert.rejects(run("set_campaign_status", { customer_id: CUSTOMER, campaign_id: "111", status: "PAUSED" }, { environment: unset }), denied("GOOGLE_ADS_TOOL_CUSTOMER_IDS"));
  await assert.rejects(run("set_campaign_budget_amount", { customer_id: "9999999999", budget_id: "333", amount_micros: 1000000 }), denied("9999999999 is not in GOOGLE_ADS_TOOL_CUSTOMER_IDS"));
  const { calls } = await run("set_campaign_status", { customer_id: CUSTOMER, campaign_id: "111", status: "PAUSED" }, { responses: [mutated] });
  assert.equal(calls.length, 1, "pausing a listed customer's campaign needs no read");
});

test("enabling a campaign needs the cap and its budget within it", async () => {
  const enable = (responses, environment = toolWrites) => run("set_campaign_status", { customer_id: CUSTOMER, campaign_id: "111", status: "ENABLED" }, { environment, responses });
  await assert.rejects(enable([], { ...toolWrites, GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS: "" }), denied("GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS"));
  // 25000001 micros is one micro over 25.00.
  await assert.rejects(enable([searchRows([{ campaign: { id: "111" }, campaignBudget: { amountMicros: "25000001" } }])]), denied("25000001"));
  await assert.rejects(enable([searchRows([])]), denied("no budget"));
  await assert.rejects(enable([{ status: 403, body: { error: { code: 403, message: "denied", status: "PERMISSION_DENIED" } } }]), denied("could not be checked"));
  const { calls } = await enable([searchRows([{ campaign: { id: "111" }, campaignBudget: { amountMicros: "25000000" } }]), mutated]);
  assert.equal(calls[0].url, `${API}/customers/${CUSTOMER}/googleAds:search`);
  assert.equal(calls[0].json.query, "SELECT campaign.id, campaign_budget.amount_micros FROM campaign WHERE campaign.id = 111");
  assert.equal(calls[1].url, `${API}/customers/${CUSTOMER}/campaigns:mutate`);
});

test("enabling an ad group checks its campaign's budget", async () => {
  const enable = (responses) => run("set_ad_group_status", { customer_id: CUSTOMER, ad_group_id: "222", status: "ENABLED" }, { responses });
  const adGroupRow = searchRows([{ adGroup: { resourceName: `customers/${CUSTOMER}/adGroups/222`, campaign: `customers/${CUSTOMER}/campaigns/111` } }]);
  await assert.rejects(enable([adGroupRow, searchRows([{ campaignBudget: { amountMicros: "90000000" } }])]), denied("90000000"));
  await assert.rejects(enable([searchRows([])]), denied("no budget"));
  const { calls } = await enable([adGroupRow, searchRows([{ campaignBudget: { amountMicros: "20000000" } }]), mutated]);
  assert.equal(calls[0].json.query, "SELECT ad_group.id, ad_group.campaign FROM ad_group WHERE ad_group.id = 222");
  assert.equal(calls[1].json.query, "SELECT campaign.id, campaign_budget.amount_micros FROM campaign WHERE campaign.id = 111");
  assert.equal(calls[2].url, `${API}/customers/${CUSTOMER}/adGroups:mutate`);
});

test("lead and user-access resources in GAQL need GOOGLE_ADS_TOOL_ALLOW_LEADS for tools", async () => {
  const sensitiveQueries = [
    "SELECT lead_form_submission_data.lead_form_submission_fields FROM lead_form_submission_data",
    "SELECT local_services_lead.contact_details FROM local_services_lead",
    "select local_services_lead_conversation.message_details from local_services_lead_conversation",
    "SELECT customer_user_access.email_address FROM customer_user_access",
    "SELECT campaign.id, lead_form_submission_data.gclid FROM campaign",
    "SELECT campaign.id FROM campaign WHERE local_services_lead.id = 1",
    "SELECT change_event.user_email FROM change_event WHERE change_event.change_date_time DURING LAST_14_DAYS",
    "SELECT customer_user_access_invitation.email_address FROM customer_user_access_invitation",
    "SELECT local_services_employee.first_name FROM local_services_employee",
  ];
  for (const query of sensitiveQueries) {
    await assert.rejects(run("search", { customer_id: CUSTOMER, query }, { environment: {} }), denied("GOOGLE_ADS_TOOL_ALLOW_LEADS"), query);
    await assert.rejects(run("search_stream", { customer_id: CUSTOMER, query }, { environment: {} }), denied("GOOGLE_ADS_TOOL_ALLOW_LEADS"), query);
  }
  const literal = await run("search", { customer_id: CUSTOMER, query: "SELECT campaign.id FROM campaign WHERE campaign.name = 'local_services_lead promo'" }, { environment: {}, responses: [searchRows([])] });
  assert.equal(literal.calls.length, 1, "names inside string literals are not resources");
  const lookalike = await run("search", { customer_id: CUSTOMER, query: "SELECT campaign.id FROM campaign_lead_form_submission_data_x" }, { environment: {}, responses: [searchRows([])] });
  assert.equal(lookalike.calls.length, 1, "tokens are compared whole, not as substrings");
  const optedIn = await run("search", { customer_id: CUSTOMER, query: sensitiveQueries[0] }, { environment: { GOOGLE_ADS_TOOL_ALLOW_LEADS: "1" }, responses: [searchRows([])] });
  assert.equal(optedIn.calls.length, 1);
  const node = await run("search", { customer_id: CUSTOMER, query: sensitiveQueries[3] }, { source: "node", environment: {}, responses: [searchRows([])] });
  assert.equal(node.calls.length, 1);
  assert.deepEqual(findSensitiveResources("SELECT customer_user_access.email_address FROM customer_user_access"), ["customer_user_access"]);
});

test("customer_id must be numeric for search, search_stream and the reports", async () => {
  for (const [operationName, args] of [
    ["search", { customer_id: "../1", query: "SELECT customer.id FROM customer" }],
    ["search_stream", { customer_id: "123abc", query: "SELECT customer.id FROM customer" }],
    ["get_campaign_performance", { customer_id: "me" }],
    ["get_search_terms", { customer_id: "1/2" }],
  ]) {
    for (const source of ["tool", "node"]) {
      await assert.rejects(run(operationName, args, { source, environment: {} }), (error) => error.kind === "invalid_input" && error.calls.length === 0, `${operationName} ${source}`);
    }
  }
});
