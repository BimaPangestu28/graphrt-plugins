/**
 * meta-ads plugin definition: ad accounts, campaigns, ad sets, ads, creatives, insights (sync and async report
 * runs), Lead Ads forms and leads, status and budget changes, and creates/deletes through the Meta Marketing API
 * (Graph API, https://developers.facebook.com/docs/marketing-api). Built with the declarative REST layer
 * (docs/declarative-plugins.md) plus wrappers:
 *   - lib/json-query-args.mjs: list params Graph takes as JSON arrays (`effective_status=["ACTIVE"]`);
 *   - lib/ad-account-id.mjs: `ad_account_id` may be `act_123` or `123`;
 *   - lib/tool-amount-cap.mjs: agent budget changes need META_ADS_TOOL_MAX_DAILY_BUDGET (minor units);
 *   - lib/tool-path-policy.mjs + lib/meta-tool-guards.mjs: api_request for tools reaches an allowlist of ad read
 *     paths and never asks for tokens; lead answers in any tool result need META_ADS_TOOL_ALLOW_LEADS=1;
 *     Every tool `fields` argument is checked too: no `.as(` aliases, token words, or leads without the opt-in,
 *     and path ids must be numeric (`act_<n>` for accounts);
 *   - lib/meta-write-guards.mjs: agent writes only touch objects of META_ADS_TOOL_ACCOUNT_IDS, and activating
 *     needs the object's effective budget within META_ADS_TOOL_MAX_DAILY_BUDGET;
 *   - lib/tool-secret-fields.mjs: `access_token` fields (Page tokens) are removed from everything tools see.
 *
 * Agent policy: reads are tools. Leads need META_ADS_TOOL_ALLOW_LEADS=1. Pausing needs META_ADS_TOOL_ALLOW_WRITES=1
 * and META_ADS_TOOL_ACCOUNT_IDS; activating and budget changes also META_ADS_TOOL_MAX_DAILY_BUDGET. Creates and
 * deletes are node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardToolWrites } from "./lib/meta-write-guards.mjs";
import { normalizeAdAccountIds } from "./lib/ad-account-id.mjs";
import { encodeListArgsAsJson } from "./lib/json-query-args.mjs";
import { refuseLeadDataWithoutOptIn, refuseTokenQueries, refuseUnsafeFieldsForTools, validateToolIds } from "./lib/meta-tool-guards.mjs";
import { capToolAmounts } from "./lib/tool-amount-cap.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";
import { stripSecretFieldsForTools } from "./lib/tool-secret-fields.mjs";

export const DEFAULT_GRAPH_VERSION = "v27.0";
const WRITE_POLICY = "optIn:META_ADS_TOOL_ALLOW_WRITES";
const LEADS_POLICY = "optIn:META_ADS_TOOL_ALLOW_LEADS";
const OBJECT_ID = "\\d+";
const AD_ACCOUNT_EDGES = "campaigns|adsets|ads|adcreatives|insights|adimages|advideos|customaudiences|adspixels|ads_volume|reachestimate|delivery_estimate";
const OBJECT_EDGES = "insights|campaigns|adsets|ads|adcreatives|copies|previews|leadgen_forms|delivery_estimate";
// Normalized GET paths agent tools may reach through api_request. Not listed: /me/accounts and every other edge
// that returns Page tokens, business and user admin edges, `leads` (list_leads, opt-in), and anything else.
const TOOL_API_PATHS = [
  "/me/adaccounts",
  `/act_${OBJECT_ID}(/(${AD_ACCOUNT_EDGES}))?`,
  `/${OBJECT_ID}(/(${OBJECT_EDGES}))?`,
].map((pattern) => new RegExp(`^${pattern}$`));

// Meta Graph error codes (https://developers.facebook.com/docs/graph-api/guides/error-handling,
// https://developers.facebook.com/docs/graph-api/overview/rate-limiting): 4 app limit, 17 user limit, 32 Pages
// limit, 613 custom/ads limits, 80000-80014 business use case limits (80000 insights, 80004 ads management,
// 80005 leadgen, ...); 190/102 bad token; 10 and 200-299 permissions; 100 invalid parameter; 2635 old version.
const RATE_LIMIT_CODES = [4, 17, 32, 341, 613, ...Array.from({ length: 15 }, (_, offset) => 80000 + offset)];
const PERMISSION_CODES = [10, 368, ...Array.from({ length: 100 }, (_, offset) => 200 + offset)];
const metaKindByCode = Object.fromEntries([
  ...RATE_LIMIT_CODES.map((code) => [code, "rate_limited"]),
  ...PERMISSION_CODES.map((code) => [code, "permission_denied"]),
  [190, "auth_error"],
  [102, "auth_error"],
  [100, "invalid_input"],
  [2635, "invalid_input"],
]);

const graphPages = { dataPath: "data", cursorPath: "paging.cursors.after", cursorParam: "after", hasMorePath: "paging.next", limitParam: "limit", maxLimit: 500, defaultLimit: 50 };
const idParam = (description) => ({ in: "path", type: "string", required: true, minLength: 1, description });
const adAccountId = idParam("Ad account id: act_<number> or the bare number");
const fieldsParam = (defaultFields) => ({ in: "query", type: "string", default: defaultFields, description: `Comma-separated fields (default ${defaultFields})` });
const listFilters = {
  effective_status: { in: "query", type: "string", description: "Statuses to include, e.g. [ACTIVE, PAUSED] (default: all except ARCHIVED and DELETED)" },
  filtering: { in: "query", type: "array", items: { type: "object" }, description: 'Filters, e.g. [{"field": "name", "operator": "CONTAIN", "value": "promo"}]' },
};
const budgetParams = {
  daily_budget: { in: "body", type: "integer", min: 1, description: "Daily budget in the ad account currency's minor units (2000 = USD 20.00; JPY, IDR and similar have no minor unit: 50000 = IDR 50,000)" },
  lifetime_budget: { in: "body", type: "integer", min: 1, description: "Lifetime budget in the account currency's minor units (needs end_time on ad sets)" },
};

const CAMPAIGN_FIELDS = "id,name,objective,status,effective_status,daily_budget,lifetime_budget,budget_remaining,bid_strategy,start_time,stop_time,created_time,updated_time";
const AD_SET_FIELDS = "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,budget_remaining,billing_event,optimization_goal,bid_amount,start_time,end_time,targeting";
const AD_FIELDS = "id,name,adset_id,campaign_id,status,effective_status,creative{id,name},created_time,updated_time";
const INSIGHT_FIELDS = "campaign_name,adset_name,ad_name,impressions,reach,clicks,ctr,cpc,cpm,spend,actions";
const DATE_PRESETS = ["today", "yesterday", "this_month", "last_month", "this_quarter", "maximum", "data_maximum", "last_3d", "last_7d", "last_14d", "last_28d", "last_30d", "last_90d", "last_week_mon_sun", "last_week_sun_sat", "last_quarter", "last_year", "this_week_mon_today", "this_week_sun_today", "this_year"];

const listQuery = (description) => ({ in: "query", type: "string", description });
const insightParams = {
  object_id: idParam("Ad account (act_<number>), campaign, ad set or ad id"),
  fields: { in: "query", type: "string", default: INSIGHT_FIELDS, description: `Comma-separated insight fields (default ${INSIGHT_FIELDS})` },
  date_preset: { in: "query", type: "string", enum: DATE_PRESETS, description: "Relative date range (default last_30d; ignored with time_range)" },
  time_range: { in: "query", type: "object", description: 'Fixed range in the account time zone, e.g. {"since": "2026-10-01", "until": "2026-10-31"} (at most 37 months back)' },
  time_increment: { in: "query", type: "string", description: '"1" for daily rows, up to "90", "monthly" or "all_days" (default)' },
  level: { in: "query", type: "string", enum: ["account", "campaign", "adset", "ad"], description: "Aggregation level" },
  // Lists sent as JSON arrays (lib/json-query-args.mjs); callers pass lists.
  breakdowns: listQuery("Breakdowns, e.g. [age, gender] or [publisher_platform] (only some combinations are allowed)"),
  action_breakdowns: listQuery("Action breakdowns, e.g. [action_type] (needs actions in fields)"),
  action_attribution_windows: listQuery("Attribution windows, e.g. [7d_click, 1d_view]"),
  filtering: listFilters.filtering,
  sort: listQuery("One sort, e.g. [spend_descending]"),
  use_unified_attribution_setting: { in: "query", type: "boolean", description: "true matches Ads Manager attribution" },
};
const INSIGHT_LIST_PARAMS = ["breakdowns", "action_breakdowns", "action_attribution_windows", "sort"];
// The async report takes the same params in a JSON body, where lists are real arrays.
const asyncInsightParams = Object.fromEntries(
  Object.entries(insightParams).map(([paramName, paramSpec]) => {
    if (paramSpec.in !== "query") return [paramName, paramSpec];
    const bodySpec = { ...paramSpec, in: "body" };
    return [paramName, INSIGHT_LIST_PARAMS.includes(paramName) ? { ...bodySpec, type: "array", items: { type: "string" } } : bodySpec];
  }),
);

const accountOperations = [
  {
    name: "list_ad_accounts",
    title: "List ad accounts",
    description: "Ad accounts the token's user or system user can access",
    path: "/me/adaccounts",
    params: { fields: fieldsParam("id,account_id,name,account_status,currency,timezone_name,amount_spent,business") },
    response: graphPages,
  },
  {
    name: "get_ad_account",
    title: "Get ad account",
    description: "An ad account's name, status, currency (budgets use its minor units), time zone and spend",
    path: "/{ad_account_id}",
    params: { ad_account_id: adAccountId, fields: fieldsParam("id,account_id,name,account_status,currency,timezone_name,amount_spent,spend_cap,balance,business") },
  },
];

const listOperation = (name, title, edge, defaultFields) => ({
  name,
  title,
  description: `${title} of an ad account (archived and deleted ones only when effective_status asks for them)`,
  path: `/{ad_account_id}/${edge}`,
  params: { ad_account_id: adAccountId, fields: fieldsParam(defaultFields), ...listFilters },
  response: graphPages,
});
const getOperation = (name, title, idName, defaultFields) => ({
  name,
  title,
  description: `${title}: settings, status and budget`,
  path: `/{${idName}}`,
  params: { [idName]: idParam(`${title.replace(/^Get /, "")} id`), fields: fieldsParam(defaultFields) },
});

const structureOperations = [
  listOperation("list_campaigns", "Campaigns", "campaigns", CAMPAIGN_FIELDS),
  listOperation("list_ad_sets", "Ad sets", "adsets", AD_SET_FIELDS),
  listOperation("list_ads", "Ads", "ads", AD_FIELDS),
  listOperation("list_ad_creatives", "Ad creatives", "adcreatives", "id,name,title,body,object_story_spec,thumbnail_url,status"),
  getOperation("get_campaign", "Get campaign", "campaign_id", CAMPAIGN_FIELDS),
  getOperation("get_ad_set", "Get ad set", "ad_set_id", AD_SET_FIELDS),
  getOperation("get_ad", "Get ad", "ad_id", AD_FIELDS),
];

const insightOperations = [
  {
    name: "get_insights",
    title: "Get insights",
    description: "Performance metrics (spend, impressions, clicks, actions...) of an ad account, campaign, ad set or ad, with date range, breakdowns and level. Use run_insights_report for large ranges or many rows",
    path: "/{object_id}/insights",
    params: insightParams,
    response: graphPages,
  },
  {
    name: "run_insights_report",
    title: "Run async insights report",
    description: "Start an asynchronous insights report (for large date ranges, many objects or breakdowns) and wait until it is done; then read the rows with get_insights_report_rows and the report_run_id (wait: false returns at once)",
    method: "POST",
    path: "/{object_id}/insights",
    write: "idempotent",
    params: asyncInsightParams,
    job: {
      idPath: "report_run_id",
      poll: { method: "GET", path: "/{id}", params: { fields: "id,async_status,async_percent_completion,date_start,date_stop" } },
      statusPath: "async_status",
      doneValues: ["Job Completed"],
      failedValues: ["Job Failed", "Job Skipped"],
      intervalMs: 5000,
      timeoutMs: 240000,
    },
  },
  {
    name: "get_insights_report_rows",
    title: "Async insights report rows",
    description: "Rows of a finished async insights report (report_run_id from run_insights_report; kept for 30 days)",
    path: "/{report_run_id}/insights",
    params: { report_run_id: idParam("report_run_id") },
    response: graphPages,
  },
];

const leadOperations = [
  {
    name: "list_lead_forms",
    title: "List lead forms",
    description: "Instant Forms (lead forms) of a Facebook Page: ids, names, status and leads count (may need a Page access token as the node's access_token)",
    path: "/{page_id}/leadgen_forms",
    params: { page_id: idParam("Facebook Page id"), fields: fieldsParam("id,name,status,leads_count,created_time,locale") },
    response: graphPages,
  },
  {
    name: "list_leads",
    title: "List leads",
    description: "Leads (form answers: personal data) of a lead form or of an ad, optionally created after a time",
    path: "/{lead_source_id}/leads",
    toolPolicy: LEADS_POLICY,
    params: {
      lead_source_id: idParam("Lead form id or ad id"),
      fields: fieldsParam("id,created_time,ad_id,form_id,field_data"),
      filtering: { in: "query", type: "array", items: { type: "object" }, description: 'e.g. [{"field": "time_created", "operator": "GREATER_THAN", "value": 1761945743}] (Unix seconds)' },
    },
    response: graphPages,
  },
];

const writeOperations = [
  {
    name: "set_status",
    title: "Pause or activate",
    description: "Pause or activate a campaign, ad set or ad (archiving and deleting are node only: delete_object)",
    method: "POST",
    path: "/{object_id}",
    bodyMode: "form",
    write: "unsafe",
    toolPolicy: WRITE_POLICY,
    checkHint: "get_campaign, get_ad_set or get_ad and read status",
    params: { object_id: idParam("Campaign, ad set or ad id"), status: { in: "body", type: "string", required: true, enum: ["ACTIVE", "PAUSED"] } },
  },
  {
    name: "set_budget",
    title: "Change budget",
    description: "Change the daily or lifetime budget of a campaign (campaign budget) or ad set, in the account currency's minor units. Agent tools also need META_ADS_TOOL_MAX_DAILY_BUDGET",
    method: "POST",
    path: "/{object_id}",
    bodyMode: "form",
    write: "unsafe",
    toolPolicy: WRITE_POLICY,
    checkHint: "get_campaign or get_ad_set and read daily_budget / lifetime_budget",
    params: { object_id: idParam("Campaign or ad set id"), ...budgetParams },
  },
];

const createParams = (params) => ({ ad_account_id: adAccountId, ...params, execution_options: { in: "body", type: "array", items: { type: "string" }, description: '["validate_only"] checks the request without creating anything' } });
const creationOperations = [
  {
    name: "create_campaign",
    title: "Create campaign",
    description: "Create a campaign (PAUSED by default)",
    method: "POST",
    path: "/{ad_account_id}/campaigns",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_campaigns and look for the name",
    params: createParams({
      name: { in: "body", type: "string", required: true, minLength: 1 },
      objective: { in: "body", type: "string", required: true, enum: ["OUTCOME_APP_PROMOTION", "OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT", "OUTCOME_LEADS", "OUTCOME_SALES", "OUTCOME_TRAFFIC"] },
      special_ad_categories: { in: "body", type: "array", items: { type: "string" }, required: true, description: "[] or e.g. [HOUSING], [EMPLOYMENT], [FINANCIAL_PRODUCTS_SERVICES], [ISSUES_ELECTIONS_POLITICS]" },
      status: { in: "body", type: "string", enum: ["ACTIVE", "PAUSED"], default: "PAUSED" },
      ...budgetParams,
      bid_strategy: { in: "body", type: "string", description: "e.g. LOWEST_COST_WITHOUT_CAP, COST_CAP, LOWEST_COST_WITH_BID_CAP" },
      spend_cap: { in: "body", type: "integer", description: "Campaign spend cap in minor units" },
    }),
  },
  {
    name: "create_ad_set",
    title: "Create ad set",
    description: "Create an ad set in a campaign (PAUSED by default)",
    method: "POST",
    path: "/{ad_account_id}/adsets",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_ad_sets and look for the name",
    params: createParams({
      name: { in: "body", type: "string", required: true, minLength: 1 },
      campaign_id: { in: "body", type: "string", required: true },
      status: { in: "body", type: "string", enum: ["ACTIVE", "PAUSED"], default: "PAUSED" },
      ...budgetParams,
      billing_event: { in: "body", type: "string", description: "e.g. IMPRESSIONS" },
      optimization_goal: { in: "body", type: "string", description: "e.g. LINK_CLICKS, REACH, OFFSITE_CONVERSIONS, LEAD_GENERATION" },
      bid_amount: { in: "body", type: "integer", description: "Bid cap in minor units" },
      targeting: { in: "body", type: "object", description: 'Targeting spec, e.g. {"geo_locations": {"countries": ["ID"]}, "age_min": 18}' },
      promoted_object: { in: "body", type: "object", description: "e.g. {pixel_id, custom_event_type} or {page_id}" },
      start_time: { in: "body", type: "string", description: "ISO 8601" },
      end_time: { in: "body", type: "string", description: "ISO 8601 (required with lifetime_budget)" },
    }),
  },
  {
    name: "create_ad_creative",
    title: "Create ad creative",
    description: "Create an ad creative",
    method: "POST",
    path: "/{ad_account_id}/adcreatives",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_ad_creatives and look for the name",
    params: createParams({
      name: { in: "body", type: "string" },
      object_story_spec: { in: "body", type: "object", description: "e.g. {page_id, link_data: {link, message, image_hash, call_to_action}}" },
      object_story_id: { in: "body", type: "string", description: "Existing Page post <page_id>_<post_id>" },
      asset_feed_spec: { in: "body", type: "object" },
      degrees_of_freedom_spec: { in: "body", type: "object" },
      url_tags: { in: "body", type: "string" },
    }),
  },
  {
    name: "create_ad",
    title: "Create ad",
    description: "Create an ad in an ad set from a creative (PAUSED by default)",
    method: "POST",
    path: "/{ad_account_id}/ads",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_ads and look for the name",
    params: createParams({
      name: { in: "body", type: "string", required: true, minLength: 1 },
      adset_id: { in: "body", type: "string", required: true },
      creative: { in: "body", type: "object", required: true, description: '{"creative_id": "<id>"}' },
      status: { in: "body", type: "string", enum: ["ACTIVE", "PAUSED"], default: "PAUSED" },
      tracking_specs: { in: "body", type: "array", items: { type: "object" } },
    }),
  },
  {
    name: "delete_object",
    title: "Delete campaign, ad set or ad",
    description: "Delete a campaign, ad set or ad (its children stop delivering; it cannot be undone)",
    method: "DELETE",
    path: "/{object_id}",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_campaign, get_ad_set or get_ad",
    params: { object_id: idParam("Campaign, ad set or ad id") },
  },
];

const restDefinition = defineRestPlugin({
  name: "meta-ads",
  version: "0.1.0",
  description: "Meta (Facebook/Instagram) ads: ad accounts, campaigns, ad sets, ads, creatives, insights and async reports, Lead Ads forms and leads; pause/activate and capped budget changes for agents after opt-in, creates and deletes node only",
  apiName: "Meta Marketing API",
  extraEnv: ["META_GRAPH_VERSION", "META_ADS_TOOL_ACCOUNT_IDS", "META_ADS_TOOL_MAX_DAILY_BUDGET", "META_ADS_TOOL_API_EXTRA_PATHS"],
  limits: { timeout_ms: 300000 },
  baseUrl: (environment) => {
    const graphVersion = environment.META_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION;
    if (!/^v\d+\.\d+$/.test(graphVersion)) throw new Error(`META_GRAPH_VERSION must look like "${DEFAULT_GRAPH_VERSION}"`);
    return `https://graph.facebook.com/${graphVersion}`;
  },
  toolUserToken: true,
  auth: { type: "bearer", env: "META_ADS_ACCESS_TOKEN" },
  // Page tokens in tool results are stripped by stripSecretFieldsForTools, which truncates afterwards.
  toolOutput: false,
  errors: {
    messagePath: ["error.error_user_msg", "error.message"],
    codePath: "error.code",
    kindByCode: metaKindByCode,
  },
  apiRequest: { examplePath: "/act_<id>/adrules_library" },
  operations: [...accountOperations, ...structureOperations, ...insightOperations, ...leadOperations, ...writeOperations, ...creationOperations],
});

const listArgsDefinition = encodeListArgsAsJson(restDefinition, ["effective_status", ...INSIGHT_LIST_PARAMS]);
const accountIdDefinition = normalizeAdAccountIds(listArgsDefinition);
const writeGuardedDefinition = guardToolWrites(accountIdDefinition, { writeEnv: "META_ADS_TOOL_ALLOW_WRITES", accountsEnv: "META_ADS_TOOL_ACCOUNT_IDS", capEnv: "META_ADS_TOOL_MAX_DAILY_BUDGET" });
const budgetCappedDefinition = capToolAmounts(writeGuardedDefinition, {
  operationNames: ["set_budget"],
  maxAmountEnv: "META_ADS_TOOL_MAX_DAILY_BUDGET",
  readCharges: (args) => [args.daily_budget, args.lifetime_budget].filter((amount) => amount !== undefined).map((amount) => ({ amount })),
  unitLabel: "the ad account currency's minor units, e.g. cents: 2000 = USD 20.00",
});
const pathGuardedDefinition = guardToolApiRequest(budgetCappedDefinition, {
  allowedPaths: TOOL_API_PATHS,
  extraAllowedPathsEnv: "META_ADS_TOOL_API_EXTRA_PATHS",
  reason: "agent tools may only read ad accounts and ad objects (/me/adaccounts, /act_<id>[/edge], /<id>[/edge]); use a workflow node",
});
const fieldGuardedDefinition = refuseUnsafeFieldsForTools(refuseTokenQueries(pathGuardedDefinition), "META_ADS_TOOL_ALLOW_LEADS");
const idCheckedDefinition = validateToolIds(fieldGuardedDefinition, ["get_insights", "run_insights_report"]);
const leadGuardedDefinition = refuseLeadDataWithoutOptIn(idCheckedDefinition, "META_ADS_TOOL_ALLOW_LEADS");

export const pluginDefinition = stripSecretFieldsForTools(leadGuardedDefinition, ["access_token"]);
