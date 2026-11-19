import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createErrorParser } from "../lib/shared/rest-errors.mjs";
import { assertReadOnlyGaql, buildDateCondition } from "../lib/gaql.mjs";
import { normalizeCustomerId } from "../lib/google-ads-auth.mjs";
import { pluginDefinition } from "../definition.mjs";

const FAKE_TOKEN = "fake-google-access-token";
const CUSTOMER = "1234567890";

async function run(operationName, args, { source = "tool", environment = {}, responses = [{ body: { results: [] } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { GOOGLE_ACCESS_TOKEN: FAKE_TOKEN, ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

const writesOn = { GOOGLE_ADS_TOOL_ALLOW_WRITES: "1", GOOGLE_ADS_TOOL_CUSTOMER_IDS: CUSTOMER };
const isKind = (kind) => (error) => error.kind === kind;
const isDenied = (fragment) => (error) => error.kind === "permission_denied" && error.message.includes(fragment);

test("search refuses anything but a SELECT and any PARAMETERS clause, before sending", async () => {
  const refusedQueries = ["", "DELETE FROM campaign", "campaign.id FROM campaign", "SELECT campaign.id FROM campaign PARAMETERS include_drafts=true", "select campaign.id from campaign parameters omit_unselected_resource_names = true"];
  for (const query of refusedQueries) {
    const recordingFetch = createRecordingFetch([]);
    const runner = createOperationRunner(pluginDefinition, { GOOGLE_ACCESS_TOKEN: FAKE_TOKEN }, { fetchImpl: recordingFetch });
    await assert.rejects(runner("search", { customer_id: CUSTOMER, query }, { source: "tool" }), isKind("invalid_input"), query);
    assert.equal(recordingFetch.calls.length, 0, query);
  }
  assert.equal(assertReadOnlyGaql("  select campaign.name FROM campaign WHERE campaign.name = 'Parameters sale' "), "select campaign.name FROM campaign WHERE campaign.name = 'Parameters sale'");
  const { calls } = await run("search_stream", { customer_id: CUSTOMER, query: "SELECT customer.id FROM customer" }, { responses: [{ body: [] }] });
  assert.deepEqual(calls[0].json, { query: "SELECT customer.id FROM customer" });
});

test("get_campaign_performance builds GAQL from validated parts and returns it with the rows", async () => {
  const responses = [{ body: { results: [{ campaign: { id: "111" }, metrics: { costMicros: "20000000" } }], nextPageToken: "page-2" } }];
  const { result, calls } = await run("get_campaign_performance", { customer_id: "123-456-7890", date_range: "LAST_7_DAYS", metrics: ["clicks", "cost_micros"], row_limit: 50 }, { responses });
  const expectedQuery =
    "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, metrics.clicks, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS AND campaign.status != 'REMOVED' ORDER BY metrics.cost_micros DESC LIMIT 50";
  assert.equal(calls[0].url, `https://googleads.googleapis.com/v26/customers/${CUSTOMER}/googleAds:search`);
  assert.deepEqual(calls[0].json, { query: expectedQuery });
  assert.deepEqual(result.data, { query: expectedQuery, rows: [{ campaign: { id: "111" }, metrics: { costMicros: "20000000" } }] });
  assert.equal(result.next_cursor, "page-2");
  const nextPage = await run("get_campaign_performance", { customer_id: CUSTOMER, date_range: "LAST_7_DAYS", metrics: ["clicks", "cost_micros"], row_limit: 50, cursor: "page-2" });
  assert.deepEqual(nextPage.calls[0].json, { query: expectedQuery, pageToken: "page-2" });
});

test("keyword and search term reports filter by numeric ids and dates", async () => {
  const keywords = await run("get_keyword_performance", { customer_id: CUSTOMER, start_date: "2026-11-01", end_date: "2026-11-18", campaign_id: "111", ad_group_id: "222" });
  assert.match(keywords.calls[0].json.query, /FROM keyword_view WHERE segments\.date BETWEEN '2026-11-01' AND '2026-11-18' AND ad_group_criterion\.status != 'REMOVED' AND campaign\.id = 111 AND ad_group\.id = 222 ORDER BY metrics\.cost_micros DESC LIMIT 100$/);
  const terms = await run("get_search_terms", { customer_id: CUSTOMER, metrics: ["impressions"] });
  assert.equal(terms.calls[0].json.query, "SELECT search_term_view.search_term, search_term_view.status, campaign.id, campaign.name, ad_group.id, ad_group.name, metrics.impressions FROM search_term_view WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.impressions DESC LIMIT 100");
  const daily = await run("get_campaign_performance", { customer_id: CUSTOMER, daily: true });
  assert.match(daily.calls[0].json.query, /campaign_budget\.amount_micros, segments\.date, metrics\.impressions/);
});

test("report arguments that could change the query are refused before sending", async () => {
  const refusedArgs = [
    { campaign_id: "111 OR campaign.id > 0" },
    { ad_group_id: "1' --" },
    { start_date: "2026-02-30", end_date: "2026-03-01" },
    { start_date: "2026-11-18", end_date: "2026-11-01" },
    { start_date: "2026-11-01" },
    { date_range: "LAST_7_DAYS", start_date: "2026-11-01", end_date: "2026-11-02" },
    { metrics: ["clicks FROM campaign"] },
  ];
  for (const args of refusedArgs) {
    const recordingFetch = createRecordingFetch([]);
    const runner = createOperationRunner(pluginDefinition, { GOOGLE_ACCESS_TOKEN: FAKE_TOKEN }, { fetchImpl: recordingFetch });
    await assert.rejects(runner("get_keyword_performance", { customer_id: CUSTOMER, ...args }, { source: "tool" }), isKind("invalid_input"), JSON.stringify(args));
    assert.equal(recordingFetch.calls.length, 0);
  }
  assert.equal(buildDateCondition({}), "segments.date DURING LAST_30_DAYS");
});

test("status changes as tools need the opt-in and send one update of status", async () => {
  await assert.rejects(run("set_campaign_status", { customer_id: CUSTOMER, campaign_id: "111", status: "PAUSED" }), isDenied("GOOGLE_ADS_TOOL_ALLOW_WRITES"));
  await assert.rejects(run("set_campaign_status", { customer_id: CUSTOMER, campaign_id: "111", status: "REMOVED" }, { environment: writesOn }), isKind("invalid_input"));
  await assert.rejects(run("set_ad_group_status", { customer_id: CUSTOMER, ad_group_id: "../222", status: "PAUSED" }, { environment: writesOn }), isKind("invalid_input"));
  const { calls } = await run("set_ad_group_status", { customer_id: "123-456-7890", ad_group_id: "222", status: "PAUSED", validate_only: true }, { environment: writesOn, responses: [{ body: { results: [] } }] });
  assert.equal(calls[0].url, `https://googleads.googleapis.com/v26/customers/${CUSTOMER}/adGroups:mutate`);
  assert.deepEqual(calls[0].json, { operations: [{ updateMask: "status", update: { resourceName: `customers/${CUSTOMER}/adGroups/222`, status: "PAUSED" } }], validateOnly: true });
});

test("budget changes as tools need GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS and stay within it", async () => {
  // 20000000 micros = 20.00 in the account currency; the cap is 25.00.
  const args = { customer_id: CUSTOMER, budget_id: "333", amount_micros: 20000000 };
  await assert.rejects(run("set_campaign_budget_amount", args), isDenied("GOOGLE_ADS_TOOL_ALLOW_WRITES"));
  for (const cap of [undefined, "0", "lots"]) {
    const environment = { ...writesOn, ...(cap === undefined ? {} : { GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS: cap }) };
    await assert.rejects(run("set_campaign_budget_amount", args, { environment }), isDenied("GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS"));
  }
  const environment = { ...writesOn, GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS: "25000000" };
  await assert.rejects(run("set_campaign_budget_amount", { ...args, amount_micros: 25000001 }, { environment }), isDenied("over GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS=25000000"));
  const { calls } = await run("set_campaign_budget_amount", args, { environment });
  assert.deepEqual(calls[0].json, { operations: [{ updateMask: "amountMicros", update: { resourceName: `customers/${CUSTOMER}/campaignBudgets/333`, amountMicros: "20000000" } }] });
  const node = await run("set_campaign_budget_amount", { ...args, amount_micros: 900000000000 }, { source: "node" });
  assert.equal(node.calls.length, 1, "workflow nodes have no cap");
});

test("mutates are never retried after a 5xx", async () => {
  const failure = { status: 503, headers: { "retry-after": "0" }, body: { error: { code: 503, message: "unavailable", status: "UNAVAILABLE" } } };
  const recordingFetch = createRecordingFetch([failure, { body: {} }]);
  const runner = createOperationRunner(pluginDefinition, { GOOGLE_ACCESS_TOKEN: FAKE_TOKEN }, { fetchImpl: recordingFetch });
  await assert.rejects(runner("set_campaign_status", { customer_id: CUSTOMER, campaign_id: "111", status: "PAUSED" }, { source: "node" }), (error) => error.retryable === false && /outcome unknown/.test(error.message));
  assert.equal(recordingFetch.calls.length, 1);
});

test("raw mutates (creates, removes, anything else) are node only", () => {
  for (const operationName of ["mutate_campaigns", "mutate_campaign_budgets", "mutate_ad_groups", "mutate_ad_group_ads", "mutate_ad_group_criteria", "mutate"]) {
    assert.equal(pluginDefinition.operations.find((operation) => operation.name === operationName).nodeOnly, true, operationName);
  }
});

test("api_request as a tool only lists customers and reads field metadata", async () => {
  for (const allowedPath of ["/customers:listAccessibleCustomers", "/googleAdsFields/campaign.name"]) {
    const { calls } = await run("api_request", { path: allowedPath }, { responses: [{ body: {} }] });
    assert.equal(calls.length, 1, allowedPath);
  }
  for (const refusedPath of [`/customers/${CUSTOMER}/invoices`, `/customers/${CUSTOMER}/paymentsAccounts`, `/customers/${CUSTOMER}/operations`, "/customers:listAccessibleCustomers/../x"]) {
    await assert.rejects(run("api_request", { path: refusedPath }), isKind("permission_denied"), refusedPath);
  }
});

test("developer-token and login-customer-id headers come from the environment", async () => {
  const environment = { GOOGLE_ADS_DEVELOPER_TOKEN: "fake-dev-token-abc", GOOGLE_ADS_LOGIN_CUSTOMER_ID: "987-654-3210" };
  const { calls } = await run("list_accessible_customers", {}, { environment, responses: [{ body: { resourceNames: [] } }] });
  assert.equal(calls[0].headers.authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(calls[0].headers["developer-token"], "fake-dev-token-abc");
  assert.equal(calls[0].headers["login-customer-id"], "9876543210");
  const without = await run("list_accessible_customers", {}, { responses: [{ body: { resourceNames: [] } }] });
  assert.equal(without.calls[0].headers["developer-token"], undefined);
  await assert.rejects(run("list_accessible_customers", {}, { environment: { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "12345" } }), isKind("invalid_input"));
});

test("the developer token is redacted from results", async () => {
  const environment = { GOOGLE_ADS_DEVELOPER_TOKEN: "fake-dev-token-abc" };
  const { result } = await run("list_accessible_customers", {}, { source: "node", environment, responses: [{ body: { resourceNames: ["echo fake-dev-token-abc"] } }] });
  assert.equal(JSON.stringify(result).includes("fake-dev-token-abc"), false);
});

test("Google Ads errors: the GoogleAdsFailure message is shown and statuses are mapped", async () => {
  const failureBody = (status, message) => ({ error: { code: 401, message: "Request had invalid authentication credentials.", status, details: [{ "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure", errors: [{ errorCode: { authenticationError: "OAUTH_TOKEN_INVALID" }, message }] }] } });
  await assert.rejects(
    run("list_accessible_customers", {}, { responses: [{ status: 401, body: failureBody("UNAUTHENTICATED", "Oauth token is invalid.") }] }),
    (error) => error.kind === "auth_error" && error.message.includes("Oauth token is invalid."),
  );
  const parseError = createErrorParser(pluginDefinition.restSpec.errors);
  assert.equal(parseError(429, { error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } }).kind, "rate_limited");
  assert.equal(parseError(403, { error: { code: 403, message: "denied", status: "PERMISSION_DENIED" } }).kind, "permission_denied");
});

test("customer ids", () => {
  assert.equal(normalizeCustomerId("123-456-7890"), CUSTOMER);
  assert.equal(normalizeCustomerId(1234567890), CUSTOMER);
  assert.equal(normalizeCustomerId("../x"), "../x");
});
