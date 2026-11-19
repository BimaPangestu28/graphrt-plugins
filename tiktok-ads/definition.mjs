/**
 * tiktok-ads plugin definition: advertiser info, campaigns, ad groups, ads, synchronous integrated reports, Instant
 * Form lead retrieval, status and budget changes, and creates/deletes through the TikTok API for Business (Marketing
 * API v1.3, https://business-api.tiktok.com/portal/docs). Built with the declarative REST layer
 * (docs/declarative-plugins.md) plus wrappers:
 *   - lib/json-query-args.mjs: list params TikTok takes as JSON arrays (`fields=["a","b"]`, `dimensions`, ...);
 *   - lib/tool-amount-cap.mjs: agent budget changes need TIKTOK_ADS_TOOL_MAX_BUDGET (account currency units);
 *   - lib/tool-path-policy.mjs: api_request for tools reaches an allowlist of read paths (no OAuth endpoints,
 *     which take the app secret);
 *   - lib/tool-secret-fields.mjs: token fields are removed from everything tools see;
 *   - lib/tiktok-write-guards.mjs: agent writes only for TIKTOK_ADS_TOOL_ADVERTISER_IDS and objects found under
 *     that advertiser; ENABLE needs each object's effective budget within TIKTOK_ADS_TOOL_MAX_BUDGET; strict
 *     budget arguments for every caller;
 *   - lib/lead-download.mjs: download_leads by hand, so JSON error answers are mapped instead of saved.
 *
 * Errors: TikTok answers HTTP 200 with `code != 0` for failures; `code` is mapped to the error kind.
 *
 * Agent policy: reads are tools. Leads need TIKTOK_ADS_TOOL_ALLOW_LEADS=1. Disabling needs
 * TIKTOK_ADS_TOOL_ALLOW_WRITES=1 and TIKTOK_ADS_TOOL_ADVERTISER_IDS; enabling and budget changes also
 * TIKTOK_ADS_TOOL_MAX_BUDGET. Creates and deletes are node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { encodeListArgsAsJson } from "./lib/json-query-args.mjs";
import { createDownloadLeadsOperation } from "./lib/lead-download.mjs";
import { guardToolWrites, validateBudgetArguments } from "./lib/tiktok-write-guards.mjs";
import { capToolAmounts } from "./lib/tool-amount-cap.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";
import { stripSecretFieldsForTools } from "./lib/tool-secret-fields.mjs";

const WRITE_POLICY = "optIn:TIKTOK_ADS_TOOL_ALLOW_WRITES";
const LEADS_POLICY = "optIn:TIKTOK_ADS_TOOL_ALLOW_LEADS";
const LIST_PARAMS = ["advertiser_ids", "fields", "dimensions", "metrics"];
// Normalized GET paths (lowercase, trailing slash dropped) agent tools may reach through api_request. Not listed:
// /oauth2/* (app secret, tokens), /lead/get and /page/lead/task/download (leads, opt-in) and anything else.
const TOOL_API_PATHS = ["/advertiser/info", "/campaign/get", "/adgroup/get", "/ad/get", "/report/integrated/get", "/page/get", "/lead/field/get", "/pixel/list", "/identity/get"].map(
  (path) => new RegExp(`^${path}$`),
);

// Return codes: https://business-api.tiktok.com/portal/docs?id=1737172488964097
const tiktokKindByCode = {
  40000: "invalid_input",
  40001: "permission_denied",
  40002: "invalid_input",
  40006: "invalid_input",
  40007: "not_found",
  40011: "invalid_input",
  40016: "rate_limited",
  40100: "rate_limited",
  40101: "auth_error",
  40102: "auth_error",
  40104: "auth_error",
  40105: "auth_error",
  40106: "auth_error",
  40108: "auth_error",
  40113: "auth_error",
  40118: "permission_denied",
  40125: "permission_denied",
  40132: "rate_limited",
  40133: "rate_limited",
  40300: "not_found",
  41000: "permission_denied",
};

const pages = (maxLimit, dataPath = "data.list") => ({ dataPath, pagePagination: { pageParam: "page", sizeParam: "page_size", totalPagesPath: "data.page_info.total_page" }, maxLimit, defaultLimit: maxLimit === 1000 ? 100 : 20 });
const advertiserId = (location) => ({ in: location, type: "string", required: true, minLength: 1, description: "Advertiser (ad account) id" });
const listQuery = (description, required = false) => ({ in: "query", type: "string", required, description });
const idList = (description) => ({ in: "body", type: "array", items: { type: "string" }, required: true, maxItems: 20, description: `${description} (1 to 20)` });
const leadRegion = { in: "header", type: "string", enum: ["eu", "us"], wireName: "x-lead-region", description: "eu: EEA, Switzerland and UK leads; us: US leads; omit for all other regions" };

const listOperation = (name, title, path, filterExample) => ({
  name,
  title,
  description: `${title} of an advertiser`,
  path,
  params: {
    advertiser_id: advertiserId("query"),
    fields: listQuery("Fields to return, e.g. [campaign_id, campaign_name, budget, operation_status] (default: all)"),
    filtering: { in: "query", type: "object", description: `Filters, e.g. ${filterExample}` },
  },
  response: pages(1000),
});

const readOperations = [
  {
    name: "get_advertiser_info",
    title: "Advertiser info",
    description: "Name, status, currency (budgets are in it), time zone, balance and company of ad accounts",
    path: "/advertiser/info/",
    params: {
      advertiser_ids: listQuery("Advertiser ids, e.g. [\"7000000000000000001\"]", true),
      fields: listQuery("Fields, e.g. [name, status, currency, timezone, balance] (default: all)"),
    },
    response: { dataPath: "data.list" },
  },
  listOperation("list_campaigns", "Campaigns", "/campaign/get/", '{"campaign_ids": ["..."], "primary_status": "STATUS_DELIVERY_OK", "objective_type": "TRAFFIC"}'),
  listOperation("list_ad_groups", "Ad groups", "/adgroup/get/", '{"campaign_ids": ["..."], "adgroup_ids": ["..."]}'),
  listOperation("list_ads", "Ads", "/ad/get/", '{"adgroup_ids": ["..."], "ad_ids": ["..."]}'),
  {
    name: "get_report",
    title: "Integrated report",
    description: "Synchronous report: metrics by dimensions for an advertiser, campaign, ad group or ad level and a date range (365 days max; 30 with stat_time_day, 1 with stat_time_hour)",
    path: "/report/integrated/get/",
    params: {
      advertiser_id: advertiserId("query"),
      report_type: { in: "query", type: "string", enum: ["BASIC", "AUDIENCE", "PLAYABLE_MATERIAL", "CATALOG"], default: "BASIC" },
      data_level: { in: "query", type: "string", enum: ["AUCTION_ADVERTISER", "AUCTION_CAMPAIGN", "AUCTION_ADGROUP", "AUCTION_AD"], description: "Required for BASIC, AUDIENCE and CATALOG" },
      dimensions: listQuery("Dimensions, e.g. [campaign_id, stat_time_day] or [ad_id] or [gender] (AUDIENCE)", true),
      metrics: listQuery("Metrics, e.g. [spend, impressions, clicks, ctr, cpc, conversion] (default [spend, impressions])"),
      start_date: { in: "query", type: "string", description: "YYYY-MM-DD in the account time zone (required unless query_lifetime)" },
      end_date: { in: "query", type: "string", description: "YYYY-MM-DD, inclusive" },
      query_lifetime: { in: "query", type: "boolean", description: "Lifetime metrics (BASIC, no time dimension)" },
      filtering: { in: "query", type: "array", items: { type: "object" }, description: 'e.g. [{"field_name": "campaign_ids", "filter_type": "IN", "filter_value": "[\\"123\\"]"}]' },
      order_field: { in: "query", type: "string", description: "Metric to sort by, e.g. spend" },
      order_type: { in: "query", type: "string", enum: ["ASC", "DESC"] },
      enable_total_metrics: { in: "query", type: "boolean", description: "Add total_metrics for the whole range" },
    },
    response: pages(1000, "data"),
  },
];

const leadParams = {
  advertiser_id: advertiserId("query"),
  lead_source: { in: "query", type: "string", enum: ["INSTANT_FORM", "DIRECT_MESSAGE"], default: "INSTANT_FORM" },
  page_id: { in: "query", type: "string", description: "Instant Form page id (required for INSTANT_FORM; from list_lead_forms)" },
};
const leadOperations = [
  {
    name: "list_lead_forms",
    title: "List Instant Forms",
    description: "Instant Forms (lead generation pages) of an advertiser: page_id, title and status",
    path: "/page/get/",
    params: {
      advertiser_id: advertiserId("query"),
      status: { in: "query", type: "string", enum: ["EDITED", "PUBLISHED"] },
      form_title: { in: "query", type: "string", wireName: "title", description: "Filter by title" },
    },
    constants: { query: { business_type: "LEAD_GEN" } },
    response: pages(100),
  },
  { name: "get_lead_form_fields", title: "Instant Form fields", description: "The questions (fields) of an Instant Form", path: "/lead/field/get/", params: leadParams },
  {
    name: "get_lead",
    title: "Get lead",
    description: "A lead of an Instant Form or a direct-message lead: answers (personal data) and campaign/ad metadata. For every lead of a form use create_lead_download_task",
    path: "/lead/get/",
    toolPolicy: LEADS_POLICY,
    params: leadParams,
  },
  {
    name: "create_lead_download_task",
    title: "Lead download task",
    description: "Start (or, with task_id, check) an export of every lead of an Instant Form or an ad; when status is SUCCEED, download_leads returns the file (ad account admins only)",
    method: "POST",
    path: "/page/lead/task/",
    // Free and read-only on TikTok's side: a repeat only starts another export.
    write: "idempotent",
    toolPolicy: LEADS_POLICY,
    params: {
      advertiser_id: advertiserId("body"),
      page_id: { in: "body", type: "string", description: "Instant Form page id (or ad_id)" },
      ad_id: { in: "body", type: "string", description: "Ad id (or page_id)" },
      task_id: { in: "body", type: "string", description: "An existing task id, to read its status" },
      lead_region: leadRegion,
    },
    response: { dataPath: "data" },
  },
  // download_leads is hand-written (lib/lead-download.mjs): JSON error answers must not be saved as the file.
];

const statusOperation = (name, title, path, idsName, idsLabel) => ({
  name,
  title,
  description: `Enable or disable ${idsLabel} (deleting is node only)`,
  method: "POST",
  path,
  write: "unsafe",
  toolPolicy: WRITE_POLICY,
  checkHint: `list the ${idsLabel} and read operation_status`,
  params: { advertiser_id: advertiserId("body"), [idsName]: idList(`${idsLabel} ids`), operation_status: { in: "body", type: "string", required: true, enum: ["ENABLE", "DISABLE"] } },
});
const deleteOperation = (name, title, path, idsName, idsLabel) => ({
  name,
  title,
  description: `Delete ${idsLabel} permanently (a deleted object can never be changed again)`,
  method: "POST",
  path,
  write: "unsafe",
  nodeOnly: true,
  checkHint: `list the ${idsLabel} with filtering on their ids`,
  params: { advertiser_id: advertiserId("body"), [idsName]: idList(`${idsLabel} ids`) },
  constants: { body: { operation_status: "DELETE" } },
});
const budgetItems = (budgetName, description) => ({ in: "body", type: "array", items: { type: "object" }, maxItems: 20, description: `${description}, e.g. [{"adgroup_id": "...", "${budgetName}": 50.5}] (up to 20)` });

const writeOperations = [
  statusOperation("set_campaign_status", "Campaign status", "/campaign/status/update/", "campaign_ids", "campaigns"),
  statusOperation("set_ad_group_status", "Ad group status", "/adgroup/status/update/", "adgroup_ids", "ad groups"),
  statusOperation("set_ad_status", "Ad status", "/ad/status/update/", "ad_ids", "ads"),
  {
    name: "set_campaign_budget",
    title: "Campaign budget",
    description: "Change a campaign's budget, in the account currency's units (e.g. 50.5 = USD 50.50; at least 105% of what it has spent). Agent tools also need TIKTOK_ADS_TOOL_MAX_BUDGET",
    method: "POST",
    path: "/campaign/update/",
    write: "unsafe",
    toolPolicy: WRITE_POLICY,
    checkHint: "list_campaigns with the campaign id and read budget",
    params: {
      advertiser_id: advertiserId("body"),
      campaign_id: { in: "body", type: "string", required: true },
      budget: { in: "body", type: "number", required: true, min: 0.01, description: "New budget in currency units (USD 2 decimals; IDR, JPY, KRW whole numbers)" },
    },
  },
  {
    name: "set_ad_group_budgets",
    title: "Ad group budgets",
    description: "Change lifetime budgets (budget, immediate) or schedule daily budgets (scheduled_budget, from 00:00 tomorrow) of up to 20 ad groups, in currency units. Agent tools also need TIKTOK_ADS_TOOL_MAX_BUDGET",
    method: "POST",
    path: "/adgroup/budget/update/",
    write: "unsafe",
    toolPolicy: WRITE_POLICY,
    checkHint: "list_ad_groups with the ad group ids and read budget",
    params: {
      advertiser_id: advertiserId("body"),
      budget: budgetItems("budget", "New lifetime budgets"),
      scheduled_budget: budgetItems("scheduled_budget", "New daily (or dynamic daily) budgets from tomorrow"),
    },
  },
];

const createOperation = (name, title, path, example) => ({
  name,
  title,
  description: `${title}: the request body as in TikTok's docs, e.g. ${example}`,
  method: "POST",
  path,
  write: "unsafe",
  nodeOnly: true,
  bodyMode: "raw",
  checkHint: "list the objects and look for the name",
  params: { request_body: { in: "body", type: "object", required: true, description: "Whole JSON body, including advertiser_id" } },
});
const creationOperations = [
  createOperation("create_campaign", "Create campaign", "/campaign/create/", '{"advertiser_id": "...", "campaign_name": "...", "objective_type": "TRAFFIC", "budget_mode": "BUDGET_MODE_DAY", "budget": 50}'),
  createOperation("create_ad_group", "Create ad group", "/adgroup/create/", '{"advertiser_id": "...", "campaign_id": "...", "adgroup_name": "...", "placement_type": "PLACEMENT_TYPE_AUTOMATIC", ...}'),
  createOperation("create_ad", "Create ad", "/ad/create/", '{"advertiser_id": "...", "adgroup_id": "...", "creatives": [...]}'),
  deleteOperation("delete_campaigns", "Delete campaigns", "/campaign/status/update/", "campaign_ids", "campaigns"),
  deleteOperation("delete_ad_groups", "Delete ad groups", "/adgroup/status/update/", "adgroup_ids", "ad groups"),
  deleteOperation("delete_ads", "Delete ads", "/ad/status/update/", "ad_ids", "ads"),
];

const restDefinition = defineRestPlugin({
  name: "tiktok-ads",
  version: "0.1.0",
  description: "TikTok ads (API for Business v1.3): advertiser info, campaigns, ad groups, ads, integrated reports, Instant Form leads (opt-in); agent enable/disable and capped budget changes after opt-in, creates and deletes node only",
  apiName: "TikTok API for Business",
  extraEnv: ["TIKTOK_ADS_TOOL_ADVERTISER_IDS", "TIKTOK_ADS_TOOL_MAX_BUDGET", "TIKTOK_ADS_TOOL_API_EXTRA_PATHS", "TIKTOK_ADS_TOOL_ALLOW_LEADS", "TIKTOK_ADS_LEADS_DIR"],
  baseUrl: "https://business-api.tiktok.com/open_api/v1.3",
  auth: { type: "header", header: "Access-Token", env: "TIKTOK_ADS_ACCESS_TOKEN" },
  // Token fields in tool results are stripped by stripSecretFieldsForTools, which truncates afterwards.
  toolOutput: false,
  errors: { messagePath: "message", codePath: "code", kindByCode: tiktokKindByCode, okPath: "code", okValue: 0 },
  apiRequest: { examplePath: "/pixel/list/" },
  operations: [...readOperations, ...leadOperations, ...writeOperations, ...creationOperations],
});

const readBudgetItems = (items, budgetName) => (Array.isArray(items) ? items.map((item) => ({ amount: item?.[budgetName] })) : []);
const downloadLeads = createDownloadLeadsOperation({ errors: restDefinition.restSpec.errors, leadsOptInEnv: "TIKTOK_ADS_TOOL_ALLOW_LEADS", directoryEnv: "TIKTOK_ADS_LEADS_DIR" });
const withDownload = { ...restDefinition, operations: [...restDefinition.operations, downloadLeads] };
const listArgsDefinition = encodeListArgsAsJson(withDownload, LIST_PARAMS);
const writeGuardedDefinition = guardToolWrites(listArgsDefinition, { writeEnv: "TIKTOK_ADS_TOOL_ALLOW_WRITES", advertisersEnv: "TIKTOK_ADS_TOOL_ADVERTISER_IDS", capEnv: "TIKTOK_ADS_TOOL_MAX_BUDGET" });
const budgetCap = { maxAmountEnv: "TIKTOK_ADS_TOOL_MAX_BUDGET", unitLabel: "account currency units, e.g. 50.5 = USD 50.50" };
const campaignCappedDefinition = capToolAmounts(writeGuardedDefinition, { ...budgetCap, operationNames: ["set_campaign_budget"], readCharges: (args) => [{ amount: args.budget }] });
// One cap for the total of every budget in the call, so 20 items cannot add up past it.
const adGroupCappedDefinition = capToolAmounts(campaignCappedDefinition, {
  ...budgetCap,
  operationNames: ["set_ad_group_budgets"],
  readCharges: (args) => [...readBudgetItems(args.budget, "budget"), ...readBudgetItems(args.scheduled_budget, "scheduled_budget")],
});
const guardedDefinition = guardToolApiRequest(adGroupCappedDefinition, {
  allowedPaths: TOOL_API_PATHS,
  extraAllowedPathsEnv: "TIKTOK_ADS_TOOL_API_EXTRA_PATHS",
  reason: "agent tools may only read advertiser info, campaigns, ad groups, ads, reports, Instant Forms, pixels and identities; use a workflow node",
});

// Outermost: malformed budget arguments are refused before any cap, read or request.
export const pluginDefinition = validateBudgetArguments(stripSecretFieldsForTools(guardedDefinition, ["access_token", "refresh_token", "secret"]));
