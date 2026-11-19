/**
 * Checks before an agent tool changes campaigns, ad groups or ads, on top of the layer's write opt-in and the
 * budget-amount cap:
 *   - account scoping: `advertiser_id` must be listed in TIKTOK_ADS_TOOL_ADVERTISER_IDS (unset refuses every agent
 *     write), and every target object is read with that advertiser first: one that is not found is refused;
 *   - re-activation: ENABLE starts spending the budget an object already has, so each target's effective budget
 *     (a campaign's own; an ad group's own, else its campaign's under campaign budget optimization; an ad's ad
 *     group's) must be finite and within TIKTOK_ADS_TOOL_MAX_BUDGET. An unset cap, no budget or a failed read
 *     refuses. DISABLE needs only the opt-in and the account checks.
 * Also validateBudgetArguments (every caller): budget items are exactly {adgroup_id, <amount field>} with a
 * positive number, and a campaign budget is positive. Workflow nodes skip the account and budget reads.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { parseMaxAmount } from "./tool-amount-cap.mjs";

const LEVELS = {
  campaign: { path: "/campaign/get/", idsFilter: "campaign_ids", idField: "campaign_id", fields: ["campaign_id", "budget", "budget_mode"] },
  adgroup: { path: "/adgroup/get/", idsFilter: "adgroup_ids", idField: "adgroup_id", fields: ["adgroup_id", "campaign_id", "budget", "budget_mode"] },
  ad: { path: "/ad/get/", idsFilter: "ad_ids", idField: "ad_id", fields: ["ad_id", "adgroup_id", "campaign_id"] },
};
// Which objects each write targets: [level, (args) => ids].
const WRITE_TARGETS = {
  set_campaign_status: ["campaign", (args) => args.campaign_ids],
  set_ad_group_status: ["adgroup", (args) => args.adgroup_ids],
  set_ad_status: ["ad", (args) => args.ad_ids],
  set_campaign_budget: ["campaign", (args) => [args.campaign_id]],
  set_ad_group_budgets: ["adgroup", (args) => [...(args.budget ?? []), ...(args.scheduled_budget ?? [])].map((item) => item?.adgroup_id)],
};

const refuse = (operationName, problem) => new PluginError(`\`${operationName}\` as an agent tool: ${problem}; use a workflow node`, { kind: "permission_denied" });
const invalid = (message) => new PluginError(message, { kind: "invalid_input" });

/**
 * Parses an advertiser allowlist.
 *
 * @param envValue - Comma-separated advertiser ids (string, optional)
 * @returns Advertiser ids (string[])
 */
export function parseAdvertiserIds(envValue) {
  return String(envValue ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * A budget that limits spend, or undefined for no limit (BUDGET_MODE_INFINITE, 0, missing).
 *
 * @param tiktokObject - Campaign or ad group from a list endpoint (object)
 * @returns Budget in currency units (number | undefined)
 */
export function readFiniteBudget(tiktokObject) {
  const budget = Number(tiktokObject?.budget);
  if (tiktokObject?.budget_mode === "BUDGET_MODE_INFINITE" || !Number.isFinite(budget) || budget <= 0) return undefined;
  return budget;
}

/**
 * Returns the definition with agent writes checked as described above.
 *
 * @param pluginDefinition - Definition (object)
 * @param envNames - `{writeEnv, advertisersEnv, capEnv}` (object)
 * @returns A new definition (object)
 */
export function guardToolWrites(pluginDefinition, envNames) {
  const wrapOperation = (operation) => {
    const target = WRITE_TARGETS[operation.name];
    if (!target) return operation;
    const run = async (context) => {
      if (context.source === "tool" && context.environment?.[envNames.writeEnv] === "1") await checkToolWrite(operation.name, target, context, envNames);
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

async function checkToolWrite(operationName, [level, readIds], context, { advertisersEnv, capEnv }) {
  const args = context.args ?? {};
  const allowedAdvertisers = parseAdvertiserIds(context.environment[advertisersEnv]);
  if (allowedAdvertisers.length === 0) throw refuse(operationName, `set ${advertisersEnv} to the advertisers agents may change`);
  if (!allowedAdvertisers.includes(String(args.advertiser_id))) throw refuse(operationName, `advertiser ${args.advertiser_id} is not in ${advertisersEnv}`);
  const enabling = args.operation_status === "ENABLE";
  const cap = parseMaxAmount(context.environment[capEnv]);
  if (enabling && cap === undefined) throw refuse(operationName, `enabling starts spending its budget: set ${capEnv} (currency units); it is unset or 0`);
  const reader = (readLevel, ids) => readObjects(operationName, context, readLevel, ids);
  const targets = await reader(level, [...new Set(readIds(args))]);
  if (!enabling) return;
  for (const [targetId, budget] of await resolveEffectiveBudgets(level, targets, reader)) {
    if (budget === undefined) throw refuse(operationName, `${targetId} has no budget on itself or its campaign, so its spend is unknown`);
    if (budget > cap) throw refuse(operationName, `${targetId} has a budget of ${budget}, over ${capEnv}=${cap} (currency units)`);
  }
}

// Returns [[targetId, budget | undefined]] for the targets of one level.
async function resolveEffectiveBudgets(level, targets, reader) {
  if (level === "campaign") return [...targets].map(([targetId, campaign]) => [targetId, readFiniteBudget(campaign)]);
  const adGroups = level === "adgroup" ? targets : await reader("adgroup", [...new Set([...targets.values()].map((ad) => ad.adgroup_id))]);
  const campaignIds = [...new Set([...adGroups.values()].filter((adGroup) => readFiniteBudget(adGroup) === undefined).map((adGroup) => adGroup.campaign_id))];
  const campaigns = campaignIds.length > 0 ? await reader("campaign", campaignIds) : new Map();
  const adGroupBudget = (adGroup) => readFiniteBudget(adGroup) ?? readFiniteBudget(campaigns.get(String(adGroup?.campaign_id)));
  return [...targets].map(([targetId, target]) => [targetId, adGroupBudget(level === "adgroup" ? target : adGroups.get(String(target.adgroup_id)))]);
}

async function readObjects(operationName, { client, args, signal }, levelName, ids) {
  const level = LEVELS[levelName];
  const query = { advertiser_id: args.advertiser_id, filtering: JSON.stringify({ [level.idsFilter]: ids }), fields: JSON.stringify(level.fields), page_size: 100 };
  let body;
  try {
    body = await client.request({ method: "GET", path: level.path, query, signal, redactResponse: true });
  } catch (readError) {
    throw refuse(operationName, `the objects could not be checked (${readError?.message ?? readError})`);
  }
  const found = new Map((body?.data?.list ?? []).map((tiktokObject) => [String(tiktokObject[level.idField]), tiktokObject]));
  const missing = ids.filter((objectId) => !found.has(String(objectId)));
  if (missing.length > 0) throw refuse(operationName, `${missing.join(", ")} not found under advertiser ${args.advertiser_id}`);
  return found;
}

/**
 * Returns the definition with budget arguments validated for every caller (nodes too): ad group budget items are
 * exactly `{adgroup_id, budget}` / `{adgroup_id, scheduled_budget}` with a positive number, and a campaign budget
 * is a positive number. Strings such as "0x10" are refused.
 *
 * @param pluginDefinition - Definition (object)
 * @returns A new definition (object)
 * @throws PluginError kind `invalid_input` (when run) - A malformed item or a non-positive amount
 */
export function validateBudgetArguments(pluginDefinition) {
  const checks = {
    set_ad_group_budgets: (args) => {
      if (args.budget === undefined && args.scheduled_budget === undefined) throw invalid("give `budget` or `scheduled_budget`");
      checkBudgetItems(args.budget, "budget");
      checkBudgetItems(args.scheduled_budget, "scheduled_budget");
    },
    set_campaign_budget: (args) => checkPositiveAmount(args.budget, "budget"),
  };
  const wrapOperation = (operation) => {
    const check = checks[operation.name];
    if (!check) return operation;
    return { ...operation, run: (context) => (check(context.args ?? {}), operation.run(context)) };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

function checkBudgetItems(items, amountField) {
  if (items === undefined) return;
  items.forEach((item, index) => {
    const label = `${amountField}[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid(`\`${label}\` must be {"adgroup_id": "...", "${amountField}": <number>}`);
    const extraKeys = Object.keys(item).filter((key) => key !== "adgroup_id" && key !== amountField);
    if (extraKeys.length > 0) throw invalid(`\`${label}\` may only have adgroup_id and ${amountField}, not ${extraKeys.join(", ")}`);
    if (typeof item.adgroup_id !== "string" || item.adgroup_id.trim() === "") throw invalid(`\`${label}.adgroup_id\` must be a non-empty string`);
    checkPositiveAmount(item[amountField], `${label}.${amountField}`);
  });
}

function checkPositiveAmount(amount, label) {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) throw invalid(`\`${label}\` must be a positive number in currency units, got ${JSON.stringify(amount ?? null)}`);
}
