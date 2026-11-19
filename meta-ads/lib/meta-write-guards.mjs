/**
 * Checks before an agent tool changes a campaign, ad set or ad (set_status, set_budget), on top of the layer's
 * write opt-in and the budget-amount cap:
 *   - account scoping: the object's ad account (read from the API, `account_id`) must be listed in
 *     META_ADS_TOOL_ACCOUNT_IDS; unset refuses every agent write;
 *   - re-activation: setting ACTIVE starts spending the budget the object already has, so its effective budget
 *     (its own daily/lifetime budget, else its ad set's, else its campaign's, as under campaign budget
 *     optimization) must be within META_ADS_TOOL_MAX_DAILY_BUDGET; unset cap, no budget found, or a failed read
 *     refuses. Pausing needs only the opt-in and the account check.
 * Agents name the object's type (`object_type`) so the right fields are read. Workflow nodes are unaffected.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { pathSegment } from "./shared/path.mjs";
import { parseMaxAmount } from "./tool-amount-cap.mjs";

const BUDGET = "daily_budget,lifetime_budget";
const BUDGET_FIELDS = {
  campaign: `account_id,${BUDGET}`,
  ad_set: `account_id,${BUDGET},campaign{${BUDGET}}`,
  ad: `account_id,adset{${BUDGET}},campaign{${BUDGET}}`,
};
const OBJECT_TYPES = { set_status: ["campaign", "ad_set", "ad"], set_budget: ["campaign", "ad_set"] };

const refuse = (operationName, problem) => new PluginError(`\`${operationName}\` as an agent tool: ${problem}; use a workflow node`, { kind: "permission_denied" });

/**
 * Parses an account allowlist: "act_111, 222" becomes ["111", "222"].
 *
 * @param envValue - Comma-separated ad account ids, with or without act_ (string, optional)
 * @returns Account ids as digits (string[])
 */
export function parseAccountIds(envValue) {
  return String(envValue ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^act_/i, ""))
    .filter((entry) => /^\d+$/.test(entry));
}

/**
 * The budget that limits spending once an object is active: the first level of its chain (object, ad set,
 * campaign) that has a positive daily or lifetime budget, and the larger of the two there.
 *
 * @param objectType - "campaign", "ad_set" or "ad" (string)
 * @param graphObject - The object read with BUDGET_FIELDS (object)
 * @returns Budget in minor units, or undefined when none is set (number | undefined)
 *
 * @example
 * readEffectiveBudget("ad_set", { daily_budget: "0", campaign: { daily_budget: "6000" } }); // 6000
 */
export function readEffectiveBudget(objectType, graphObject) {
  const chains = { campaign: [graphObject], ad_set: [graphObject, graphObject?.campaign], ad: [graphObject?.adset, graphObject?.campaign] };
  for (const level of chains[objectType] ?? []) {
    const budgets = [level?.daily_budget, level?.lifetime_budget].map(Number).filter((budget) => Number.isFinite(budget) && budget > 0);
    if (budgets.length > 0) return Math.max(...budgets);
  }
  return undefined;
}

/**
 * Returns the definition with set_status and set_budget tool calls checked as described above.
 *
 * @param pluginDefinition - Definition (object)
 * @param envNames - `{writeEnv, accountsEnv, capEnv}` (object)
 * @returns A new definition; the operations gain an `object_type` argument (object)
 */
export function guardToolWrites(pluginDefinition, envNames) {
  const wrapOperation = (operation) => {
    const objectTypes = OBJECT_TYPES[operation.name];
    if (!objectTypes) return operation;
    const objectTypeSchema = { type: "string", enum: objectTypes, description: "What object_id is (required for agent tools: the account and budget are read before the change)" };
    const parameters = { ...operation.parameters, properties: { ...operation.parameters.properties, object_type: objectTypeSchema } };
    const run = async (context) => {
      const { object_type: objectType, ...args } = context.args ?? {};
      if (context.source === "tool" && context.environment?.[envNames.writeEnv] === "1") await checkToolWrite(operation.name, objectType, { ...context, args }, envNames);
      return operation.run({ ...context, args });
    };
    return { ...operation, parameters, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

async function checkToolWrite(operationName, objectType, context, { accountsEnv, capEnv }) {
  if (!objectType) throw new PluginError(`\`${operationName}\` as an agent tool needs \`object_type\` (campaign, ad_set or ad)`, { kind: "invalid_input" });
  const allowedAccounts = parseAccountIds(context.environment[accountsEnv]);
  if (allowedAccounts.length === 0) throw refuse(operationName, `set ${accountsEnv} to the ad accounts agents may change`);
  const activating = operationName === "set_status" && context.args.status === "ACTIVE";
  const cap = parseMaxAmount(context.environment[capEnv]);
  if (activating && cap === undefined) throw refuse(operationName, `activating starts spending its budget: set ${capEnv} (minor units); it is unset or 0`);
  const graphObject = await readObject(operationName, context, activating ? BUDGET_FIELDS[objectType] : "account_id");
  const accountId = String(graphObject?.account_id ?? "");
  if (!allowedAccounts.includes(accountId)) throw refuse(operationName, `the object's ad account ${accountId || "(unknown)"} is not in ${accountsEnv}`);
  if (!activating) return;
  const budget = readEffectiveBudget(objectType, graphObject);
  if (budget === undefined) throw refuse(operationName, "no budget was found on the object, its ad set or its campaign, so its spend is unknown");
  if (budget > cap) throw refuse(operationName, `its budget ${budget} is over ${capEnv}=${cap} (minor units)`);
}

async function readObject(operationName, { client, args, signal }, fields) {
  try {
    return await client.request({ method: "GET", path: `/${pathSegment(args.object_id)}`, query: { fields }, signal, redactResponse: true });
  } catch (readError) {
    throw refuse(operationName, `the object's account and budget could not be checked (${readError?.message ?? readError})`);
  }
}
