/**
 * Google Ads agent guards on top of the write opt-in and the budget-amount cap:
 *   - guardSearches: `customer_id` of search and search_stream must be numeric (every caller), and for agent
 *     tools GAQL that names a lead or user-access resource (lead_form_submission_data, local_services_lead,
 *     local_services_lead_conversation, customer_user_access) anywhere outside string literals needs the leads
 *     opt-in. The query is tokenised: identifiers are compared whole, by their resource segment.
 *   - guardToolWrites: agent writes only for customers in GOOGLE_ADS_TOOL_CUSTOMER_IDS (unset refuses every agent
 *     write); setting ENABLED starts spending the campaign budget that is already there, so the campaign's budget
 *     (for an ad group: its campaign's) is read first and must be within GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS.
 *     An unset cap, no budget, or a failed read refuses. Pausing needs only the opt-in and the customer check.
 * Workflow nodes are unaffected except for the numeric customer id.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { normalizeCustomerId } from "./google-ads-auth.mjs";
import { assertNumericId } from "./gaql.mjs";
import { parseMaxAmount } from "./tool-amount-cap.mjs";

// Lead answers and people's contact data (user emails in change history and access invitations, employee names).
export const SENSITIVE_RESOURCES = [
  "lead_form_submission_data",
  "local_services_lead",
  "local_services_lead_conversation",
  "local_services_employee",
  "customer_user_access",
  "customer_user_access_invitation",
  "change_event",
];
const STRING_LITERALS = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;
const IDENTIFIERS = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/g;
const SEARCH_OPERATIONS = new Set(["search", "search_stream"]);
const WRITE_OPERATIONS = new Set(["set_campaign_status", "set_ad_group_status", "set_campaign_budget_amount"]);

const refuse = (operationName, problem) => new PluginError(`\`${operationName}\` as an agent tool: ${problem}; use a workflow node`, { kind: "permission_denied" });

/**
 * Lists the sensitive resources a GAQL query names, outside string literals.
 *
 * @param query - GAQL text (string)
 * @returns Resource names found, without duplicates (string[])
 *
 * @example
 * findSensitiveResources("SELECT local_services_lead.id FROM local_services_lead"); // ["local_services_lead"]
 */
export function findSensitiveResources(query) {
  const identifiers = String(query ?? "").replace(STRING_LITERALS, "''").match(IDENTIFIERS) ?? [];
  const resources = identifiers.map((identifier) => identifier.split(".")[0].toLowerCase());
  return [...new Set(resources.filter((resource) => SENSITIVE_RESOURCES.includes(resource)))];
}

/**
 * Returns the definition with search and search_stream checked as described above.
 *
 * @param pluginDefinition - Definition (object)
 * @param leadsOptInEnv - e.g. "GOOGLE_ADS_TOOL_ALLOW_LEADS" (string)
 * @returns A new definition (object)
 */
export function guardSearches(pluginDefinition, leadsOptInEnv) {
  const wrapOperation = (operation) => {
    if (!SEARCH_OPERATIONS.has(operation.name)) return operation;
    const run = (context) => {
      const args = context.args ?? {};
      const customerId = args.customer_id === undefined ? undefined : assertNumericId(normalizeCustomerId(args.customer_id), "customer_id");
      const sensitive = context.source === "tool" && context.environment?.[leadsOptInEnv] !== "1" ? findSensitiveResources(args.query) : [];
      if (sensitive.length > 0) throw refuse(operation.name, `${sensitive.join(", ")} hold personal data (leads, user emails); set ${leadsOptInEnv}=1 to let agents query them`);
      return operation.run({ ...context, args: customerId === undefined ? args : { ...args, customer_id: customerId } });
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

/**
 * Parses a customer allowlist: "123-456-7890, 1111111111" becomes ["1234567890", "1111111111"].
 *
 * @param envValue - Comma-separated customer ids (string, optional)
 * @returns Customer ids as digits (string[])
 */
export function parseCustomerIds(envValue) {
  return String(envValue ?? "")
    .split(",")
    .map((entry) => normalizeCustomerId(entry.trim()))
    .filter((entry) => /^\d+$/.test(entry));
}

/**
 * Returns the definition with the simple mutates (id-based arguments) checked for agent tools as described above.
 *
 * @param pluginDefinition - Definition after simplifyStatusAndBudgetMutates (object)
 * @param envNames - `{writeEnv, customersEnv, capEnv}` (object)
 * @returns A new definition (object)
 */
export function guardToolWrites(pluginDefinition, envNames) {
  const wrapOperation = (operation) => {
    if (!WRITE_OPERATIONS.has(operation.name)) return operation;
    const run = async (context) => {
      if (context.source === "tool" && context.environment?.[envNames.writeEnv] === "1") await checkToolWrite(operation.name, context, envNames);
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

async function checkToolWrite(operationName, context, { customersEnv, capEnv }) {
  const args = context.args ?? {};
  const allowedCustomers = parseCustomerIds(context.environment[customersEnv]);
  if (allowedCustomers.length === 0) throw refuse(operationName, `set ${customersEnv} to the customers agents may change`);
  const customerId = assertNumericId(normalizeCustomerId(args.customer_id), "customer_id");
  if (!allowedCustomers.includes(customerId)) throw refuse(operationName, `customer ${customerId} is not in ${customersEnv}`);
  if (args.status !== "ENABLED") return;
  const cap = parseMaxAmount(context.environment[capEnv]);
  if (cap === undefined) throw refuse(operationName, `enabling starts spending the campaign budget: set ${capEnv}; it is unset or 0`);
  const budgetMicros = await readCampaignBudgetMicros(operationName, context, customerId);
  if (budgetMicros === undefined) throw refuse(operationName, "no budget was found on the campaign, so its spend is unknown");
  if (budgetMicros > cap) throw refuse(operationName, `the campaign budget ${budgetMicros} micros is over ${capEnv}=${cap}`);
}

async function readCampaignBudgetMicros(operationName, context, customerId) {
  const search = (query) => runSearch(operationName, context, customerId, query);
  let campaignId = context.args.campaign_id;
  if (operationName === "set_ad_group_status") {
    const adGroupId = assertNumericId(context.args.ad_group_id, "ad_group_id");
    const [adGroupRow] = await search(`SELECT ad_group.id, ad_group.campaign FROM ad_group WHERE ad_group.id = ${adGroupId}`);
    campaignId = /\/campaigns\/(\d+)$/.exec(adGroupRow?.adGroup?.campaign ?? "")?.[1];
    if (!campaignId) return undefined;
  }
  const [campaignRow] = await search(`SELECT campaign.id, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${assertNumericId(campaignId, "campaign_id")}`);
  const budgetMicros = Number(campaignRow?.campaignBudget?.amountMicros);
  return Number.isFinite(budgetMicros) && budgetMicros > 0 ? budgetMicros : undefined;
}

async function runSearch(operationName, { client, signal }, customerId, query) {
  try {
    const body = await client.request({ method: "POST", path: `/customers/${customerId}/googleAds:search`, json: { query }, idempotent: true, signal, redactResponse: true });
    return body?.results ?? [];
  } catch (readError) {
    throw refuse(operationName, `the campaign budget could not be checked (${readError?.message ?? readError})`);
  }
}
