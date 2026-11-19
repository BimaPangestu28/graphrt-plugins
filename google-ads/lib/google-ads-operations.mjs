/**
 * Google Ads wrappers around the declarative operations:
 *   - validateSearchQueries: search/search_stream refuse non-SELECT GAQL and PARAMETERS (lib/gaql.mjs);
 *   - normalizeCustomerIds: `customer_id` may be typed with dashes (123-456-7890);
 *   - simplifyStatusAndBudgetMutates: set_campaign_status, set_ad_group_status and set_campaign_budget_amount take
 *     ids and a value instead of raw mutate operations, so an agent can only send one `update` of one field;
 *   - createReportOperations: campaign, keyword and search-term reports built from validated GAQL parts on top of
 *     the `search` operation.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { normalizeCustomerId } from "./google-ads-auth.mjs";
import { assertNumericId, assertReadOnlyGaql, buildDateCondition, buildReportQuery, DATE_RANGES, REPORT_METRICS, resolveReportMetrics } from "./gaql.mjs";

const SEARCH_OPERATIONS = new Set(["search", "search_stream"]);
const MAX_REPORT_ROWS = 10000;

const mapOperations = (pluginDefinition, wrapOperation) => ({ ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) });
const withArgs = (operation, transformArgs) => ({ ...operation, run: (context) => operation.run({ ...context, args: transformArgs(context.args ?? {}) }) });

/**
 * Returns the definition with GAQL checked before search and search_stream send anything.
 *
 * @param pluginDefinition - Definition (object)
 * @returns A new definition (object)
 */
export function validateSearchQueries(pluginDefinition) {
  return mapOperations(pluginDefinition, (operation) => {
    if (!SEARCH_OPERATIONS.has(operation.name)) return operation;
    return withArgs(operation, (args) => (args.query === undefined ? args : { ...args, query: assertReadOnlyGaql(args.query) }));
  });
}

/**
 * Returns the definition with `customer_id` arguments normalized (dashes removed) before every operation runs.
 *
 * @param pluginDefinition - Definition (object)
 * @returns A new definition (object)
 */
export function normalizeCustomerIds(pluginDefinition) {
  return mapOperations(pluginDefinition, (operation) => {
    if (!operation.parameters?.properties?.customer_id) return operation;
    return withArgs(operation, (args) => (args.customer_id === undefined ? args : { ...args, customer_id: normalizeCustomerId(args.customer_id) }));
  });
}

const customerIdSchema = { type: "string", description: "Customer (account) id, e.g. 1234567890 or 123-456-7890" };
const validateOnlySchema = { type: "boolean", description: "Check the change without applying it (default false)" };

// Each simple mutate: its own parameters, and how they become one `update` operation.
const SIMPLE_MUTATES = {
  set_campaign_status: {
    properties: { campaign_id: { type: "string", description: "Campaign id" }, status: { type: "string", enum: ["ENABLED", "PAUSED"] } },
    required: ["campaign_id", "status"],
    buildUpdate: (customerId, args) => ({ updateMask: "status", update: { resourceName: `customers/${customerId}/campaigns/${assertNumericId(args.campaign_id, "campaign_id")}`, status: args.status } }),
  },
  set_ad_group_status: {
    properties: { ad_group_id: { type: "string", description: "Ad group id" }, status: { type: "string", enum: ["ENABLED", "PAUSED"] } },
    required: ["ad_group_id", "status"],
    buildUpdate: (customerId, args) => ({ updateMask: "status", update: { resourceName: `customers/${customerId}/adGroups/${assertNumericId(args.ad_group_id, "ad_group_id")}`, status: args.status } }),
  },
  set_campaign_budget_amount: {
    properties: {
      budget_id: { type: "string", description: "Campaign budget id (campaign.campaign_budget is customers/<id>/campaignBudgets/<budget_id>)" },
      amount_micros: { type: "integer", minimum: 1, description: "New amount in micros of the account currency: 20000000 = 20.00 (USD 20.00, or IDR 20 on an IDR account)" },
    },
    required: ["budget_id", "amount_micros"],
    buildUpdate: (customerId, args) => ({
      updateMask: "amountMicros",
      update: { resourceName: `customers/${customerId}/campaignBudgets/${assertNumericId(args.budget_id, "budget_id")}`, amountMicros: String(args.amount_micros) },
    }),
  },
};

/**
 * Replaces the raw `operations` argument of the simple mutate operations with ids and one value.
 *
 * @param pluginDefinition - Definition whose simple mutates take `{customer_id, operations, validate_only}` (object)
 * @returns A new definition (object)
 * @throws PluginError kind `invalid_input` (when run) - An id is not numeric
 */
export function simplifyStatusAndBudgetMutates(pluginDefinition) {
  return mapOperations(pluginDefinition, (operation) => {
    const simpleMutate = SIMPLE_MUTATES[operation.name];
    if (!simpleMutate) return operation;
    const parameters = {
      type: "object",
      properties: { customer_id: customerIdSchema, ...simpleMutate.properties, validate_only: validateOnlySchema },
      required: ["customer_id", ...simpleMutate.required],
    };
    const run = (context) => {
      const args = context.args ?? {};
      const customerId = assertNumericId(normalizeCustomerId(args.customer_id), "customer_id");
      const mutateArgs = { customer_id: customerId, operations: [simpleMutate.buildUpdate(customerId, args)], validate_only: args.validate_only };
      return operation.run({ ...context, args: mutateArgs });
    };
    return { ...operation, parameters, run };
  });
}

const reportSchemaProperties = {
  customer_id: customerIdSchema,
  date_range: { type: "string", enum: DATE_RANGES, description: "Relative range in the account time zone (default LAST_30_DAYS)" },
  start_date: { type: "string", description: "YYYY-MM-DD (with end_date, instead of date_range)" },
  end_date: { type: "string", description: "YYYY-MM-DD, inclusive" },
  metrics: { type: "array", items: { type: "string", enum: REPORT_METRICS }, description: "Metrics (default impressions, clicks, ctr, average_cpc, cost_micros, conversions); cost is in micros" },
  campaign_id: { type: "string", description: "Only this campaign" },
  row_limit: { type: "integer", minimum: 1, maximum: MAX_REPORT_ROWS, default: 100, description: "Maximum rows, highest cost first" },
  cursor: { type: "string", description: "next_cursor from the previous call, to get the next page" },
};

const REPORTS = [
  {
    name: "get_campaign_performance",
    title: "Campaign performance",
    description: "Metrics per campaign (id, name, status, channel, budget) for a date range, highest cost first; removed campaigns are left out",
    resource: "campaign",
    fields: ["campaign.id", "campaign.name", "campaign.status", "campaign.advertising_channel_type", "campaign_budget.amount_micros"],
    baseConditions: ["campaign.status != 'REMOVED'"],
    extraProperties: { daily: { type: "boolean", default: false, description: "One row per campaign and day (adds segments.date)" } },
  },
  {
    name: "get_keyword_performance",
    title: "Keyword performance",
    description: "Metrics per keyword (text, match type, status, ad group, campaign) for a date range, highest cost first; removed keywords are left out",
    resource: "keyword_view",
    fields: ["campaign.id", "campaign.name", "ad_group.id", "ad_group.name", "ad_group_criterion.criterion_id", "ad_group_criterion.keyword.text", "ad_group_criterion.keyword.match_type", "ad_group_criterion.status"],
    baseConditions: ["ad_group_criterion.status != 'REMOVED'"],
    extraProperties: { ad_group_id: { type: "string", description: "Only this ad group" } },
  },
  {
    name: "get_search_terms",
    title: "Search terms",
    description: "Search queries that triggered ads (search term, whether it was added or excluded, ad group, campaign) with metrics, highest cost first",
    resource: "search_term_view",
    fields: ["search_term_view.search_term", "search_term_view.status", "campaign.id", "campaign.name", "ad_group.id", "ad_group.name"],
    baseConditions: [],
    extraProperties: { ad_group_id: { type: "string", description: "Only this ad group" } },
  },
];

/**
 * Builds the GAQL of one convenience report from validated arguments.
 *
 * @param report - Entry of REPORTS (object)
 * @param args - Report arguments (object)
 * @returns GAQL text (string)
 * @throws PluginError kind `invalid_input` - Invalid dates, metrics or ids
 */
export function buildReportGaql(report, args) {
  const conditions = [buildDateCondition(args), ...report.baseConditions];
  if (args.campaign_id !== undefined) conditions.push(`campaign.id = ${assertNumericId(args.campaign_id, "campaign_id")}`);
  if (args.ad_group_id !== undefined) conditions.push(`ad_group.id = ${assertNumericId(args.ad_group_id, "ad_group_id")}`);
  const fields = args.daily ? [...report.fields, "segments.date"] : report.fields;
  const limit = args.row_limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REPORT_ROWS) throw new PluginError(`\`row_limit\` must be 1 to ${MAX_REPORT_ROWS}`, { kind: "invalid_input" });
  return buildReportQuery({ fields, metrics: resolveReportMetrics(args.metrics), resource: report.resource, conditions, limit });
}

/**
 * Creates the convenience report operations, each running the given `search` operation with its built query.
 *
 * @param searchOperation - The (wrapped) `search` operation (object)
 * @returns Report operations (object[])
 */
export function createReportOperations(searchOperation) {
  return REPORTS.map((report) => ({
    name: report.name,
    title: report.title,
    description: `${report.description}. Built on search; the GAQL sent is returned as data.query`,
    parameters: { type: "object", properties: { ...reportSchemaProperties, ...report.extraProperties }, required: ["customer_id"] },
    run: async (context) => {
      const args = context.args ?? {};
      const customerId = assertNumericId(normalizeCustomerId(args.customer_id), "customer_id");
      const query = buildReportGaql(report, args);
      const result = await searchOperation.run({ ...context, args: { customer_id: customerId, query, cursor: args.cursor } });
      return { ...result, data: { query, rows: result.data } };
    },
  }));
}
