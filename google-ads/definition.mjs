/**
 * google-ads plugin definition: accessible customers, GAQL search and searchStream, campaign/keyword/search-term
 * reports, status and budget changes, and raw mutates through the Google Ads API REST interface (v26,
 * https://developers.google.com/google-ads/api/rest/overview). Built with the declarative REST layer
 * (docs/declarative-plugins.md); Google OAuth comes from the shared Google auth files (lib/google-rest-auth.mjs and
 * friends, copied byte for byte from google-analytics), plus:
 *   - lib/google-ads-auth.mjs: `adwords` scope, optional `developer-token` and `login-customer-id` headers;
 *   - lib/gaql.mjs + lib/google-ads-operations.mjs: GAQL checks, reports, simple status/budget mutates;
 *   - lib/tool-amount-cap.mjs: agent budget changes need GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS;
 *   - lib/tool-path-policy.mjs: api_request for tools reaches an allowlist of read paths;
 *   - lib/tool-secret-fields.mjs: token fields are removed from everything tools see.
 *
 * Agent policy: reads are tools. Campaign/ad group pause/enable needs GOOGLE_ADS_TOOL_ALLOW_WRITES=1; budget
 * amounts also GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS. Raw mutates (creates, removes, anything else) are node only.
 * Every mutate is `unsafe`: never retried after a 5xx or network failure. lib/google-ads-guards.mjs adds: agent
 * writes only for GOOGLE_ADS_TOOL_CUSTOMER_IDS, ENABLED only when the campaign budget is within the cap, lead and
 * user-access resources in agent GAQL only with GOOGLE_ADS_TOOL_ALLOW_LEADS=1, and numeric customer ids.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardSearches, guardToolWrites } from "./lib/google-ads-guards.mjs";
import { createGoogleErrors, GOOGLE_AUTH_ENV, withGoogleCredentials } from "./lib/google-rest-auth.mjs";
import { createGoogleAdsAuth, GOOGLE_ADS_AUTH_ENV } from "./lib/google-ads-auth.mjs";
import { createReportOperations, normalizeCustomerIds, simplifyStatusAndBudgetMutates, validateSearchQueries } from "./lib/google-ads-operations.mjs";
import { capToolAmounts } from "./lib/tool-amount-cap.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";
import { stripSecretFieldsForTools } from "./lib/tool-secret-fields.mjs";

export const GOOGLE_ADS_API_VERSION = "v26";
const WRITE_POLICY = "optIn:GOOGLE_ADS_TOOL_ALLOW_WRITES";
// Normalized GET paths agent tools may reach through api_request. Not listed: invoices, payments accounts,
// identity verification, batch jobs and anything else.
const TOOL_API_PATHS = ["/customers:listaccessiblecustomers", "/googleadsfields/[^/]+"].map((pattern) => new RegExp(`^${pattern}$`));

const customerId = { in: "path", type: "string", required: true, minLength: 1, description: "Customer (account) id, digits, e.g. 1234567890 (dashes are removed)" };
const gaqlQuery = { in: "body", type: "string", required: true, minLength: 1, description: "GAQL, e.g. SELECT campaign.id, campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS" };
const validateOnly = { in: "body", type: "boolean", wireName: "validateOnly", description: "Check the request without applying it" };
const mutateOptions = {
  partial_failure: { in: "body", type: "boolean", wireName: "partialFailure", description: "Apply the valid operations even if others fail" },
  validate_only: validateOnly,
  response_content_type: { in: "body", type: "string", enum: ["RESOURCE_NAME_ONLY", "MUTABLE_RESOURCE"], wireName: "responseContentType" },
};

const readOperations = [
  {
    name: "list_accessible_customers",
    title: "Accessible customers",
    description: "Customer resource names (customers/<id>) the OAuth user can access directly",
    path: "/customers:listAccessibleCustomers",
    response: { dataPath: "resourceNames" },
  },
  {
    name: "search",
    title: "Search (GAQL)",
    description: "Run a GAQL SELECT query (attributes, segments, metrics of any resource), 10000 rows per page. PARAMETERS clauses are refused",
    method: "POST",
    path: "/customers/{customer_id}/googleAds:search",
    write: "idempotent",
    params: { customer_id: customerId, query: gaqlQuery },
    response: { dataPath: "results", cursorPath: "nextPageToken", cursorParam: "pageToken" },
  },
  {
    name: "search_stream",
    title: "Search stream (GAQL)",
    description: "Run a GAQL SELECT query and return every row at once as batches ([{results, fieldMask}]); for large exports prefer nodes",
    method: "POST",
    path: "/customers/{customer_id}/googleAds:searchStream",
    write: "idempotent",
    timeoutMs: 120000,
    params: { customer_id: customerId, query: gaqlQuery },
  },
];

// Agent-callable mutates: simplifyStatusAndBudgetMutates replaces `operations` with ids and one value.
const simpleMutate = (name, title, resourcePath, description, checkHint) => ({
  name,
  title,
  description,
  method: "POST",
  path: `/customers/{customer_id}/${resourcePath}:mutate`,
  write: "unsafe",
  toolPolicy: WRITE_POLICY,
  checkHint,
  params: { customer_id: customerId, operations: { in: "body", type: "array", items: { type: "object" }, required: true, maxItems: 1 }, validate_only: validateOnly },
});
const writeOperations = [
  simpleMutate("set_campaign_status", "Campaign status", "campaigns", "Pause or enable a campaign", "get_campaign_performance or search campaign.status"),
  simpleMutate("set_ad_group_status", "Ad group status", "adGroups", "Pause or enable an ad group", "search ad_group.status"),
  simpleMutate(
    "set_campaign_budget_amount",
    "Campaign budget amount",
    "campaignBudgets",
    "Change a campaign budget's amount, in micros of the account currency (20000000 = 20.00). Agent tools also need GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS",
    "search campaign_budget.amount_micros",
  ),
];

const rawMutate = (name, title, resourcePath, operationsName, example) => ({
  name,
  title,
  description: `${title}: create, update or remove operations, e.g. ${example}`,
  method: "POST",
  path: `/customers/{customer_id}/${resourcePath}:mutate`,
  write: "unsafe",
  nodeOnly: true,
  checkHint: "search the changed resources",
  params: {
    customer_id: customerId,
    operations: { in: "body", type: "array", items: { type: "object" }, required: true, wireName: operationsName, description: "Mutate operations as in the REST reference" },
    ...mutateOptions,
  },
});
const rawMutateOperations = [
  rawMutate("mutate_campaigns", "Campaign mutate", "campaigns", "operations", '[{"create": {"name": "...", "status": "PAUSED", "campaignBudget": "customers/1/campaignBudgets/2", "advertisingChannelType": "SEARCH", "manualCpc": {}}}]'),
  rawMutate("mutate_campaign_budgets", "Campaign budget mutate", "campaignBudgets", "operations", '[{"create": {"name": "...", "amountMicros": "20000000", "deliveryMethod": "STANDARD"}}]'),
  rawMutate("mutate_ad_groups", "Ad group mutate", "adGroups", "operations", '[{"remove": "customers/1/adGroups/3"}]'),
  rawMutate("mutate_ad_group_ads", "Ad group ad mutate", "adGroupAds", "operations", '[{"update": {"resourceName": "customers/1/adGroupAds/3~4", "status": "PAUSED"}, "updateMask": "status"}]'),
  rawMutate("mutate_ad_group_criteria", "Ad group criteria mutate", "adGroupCriteria", "operations", '[{"create": {"adGroup": "customers/1/adGroups/3", "keyword": {"text": "shoes", "matchType": "PHRASE"}}}]'),
  rawMutate("mutate", "Multi-resource mutate", "googleAds", "mutateOperations", '[{"campaignOperation": {"update": {...}, "updateMask": "name"}}]'),
];

const restDefinition = defineRestPlugin({
  name: "google-ads",
  version: "0.1.0",
  description: "Google Ads API: accessible customers, GAQL search and searchStream, campaign/keyword/search-term reports; agent pause/enable and capped budget changes after opt-in, other mutates node only (OAuth or service account)",
  apiName: "Google Ads API",
  extraEnv: [...GOOGLE_ADS_AUTH_ENV, "GOOGLE_ADS_TOOL_CUSTOMER_IDS", "GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS", "GOOGLE_ADS_TOOL_ALLOW_LEADS", "GOOGLE_ADS_TOOL_API_EXTRA_PATHS"],
  limits: { timeout_ms: 150000 },
  baseUrl: `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`,
  toolUserToken: { credentialEnv: GOOGLE_AUTH_ENV },
  auth: createGoogleAdsAuth(),
  // Token fields in tool results are stripped by stripSecretFieldsForTools, which truncates afterwards.
  toolOutput: false,
  errors: { ...createGoogleErrors("error.status"), messagePath: ["error.details.0.errors.0.message", "error.message"] },
  apiRequest: { examplePath: "/customers:listAccessibleCustomers" },
  operations: [...readOperations, ...writeOperations, ...rawMutateOperations],
});

// The contract suite runs on this definition: every declarative operation with its own arguments.
export const contractDefinition = normalizeCustomerIds(validateSearchQueries(withGoogleCredentials(restDefinition)));

const simplifiedDefinition = simplifyStatusAndBudgetMutates(contractDefinition);
const searchOperation = simplifiedDefinition.operations.find((operation) => operation.name === "search");
const reportDefinition = { ...simplifiedDefinition, operations: [...simplifiedDefinition.operations, ...createReportOperations(searchOperation)] };
const writeGuardedDefinition = guardToolWrites(reportDefinition, { writeEnv: "GOOGLE_ADS_TOOL_ALLOW_WRITES", customersEnv: "GOOGLE_ADS_TOOL_CUSTOMER_IDS", capEnv: "GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS" });
const cappedDefinition = capToolAmounts(writeGuardedDefinition, {
  operationNames: ["set_campaign_budget_amount"],
  maxAmountEnv: "GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS",
  readCharges: (args) => [{ amount: args.amount_micros }],
  unitLabel: "micros of the account currency: 20000000 = 20.00",
});
const searchGuardedDefinition = guardSearches(cappedDefinition, "GOOGLE_ADS_TOOL_ALLOW_LEADS");
const guardedDefinition = guardToolApiRequest(searchGuardedDefinition, {
  allowedPaths: TOOL_API_PATHS,
  extraAllowedPathsEnv: "GOOGLE_ADS_TOOL_API_EXTRA_PATHS",
  reason: "agent tools may only list accessible customers and read field metadata; use search for data or a workflow node",
});

export const pluginDefinition = stripSecretFieldsForTools(guardedDefinition, ["access_token", "refresh_token", "developer_token"]);
