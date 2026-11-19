/**
 * Amount caps for money-creating operations that agents may call after an opt-in (payment intents, payment links,
 * invoices, orders). On top of the layer's `toolPolicy` opt-in, a tool call is refused unless:
 *   - `$maxAmountEnv` is a positive number (unset, empty, 0 or not a number refuses every tool call), and
 *   - the call's total amount (the sum of its amounts, in the API's own unit) is positive and at most that number, and
 *   - when the operation has a currency, it is listed in `$currencyEnv` (comma-separated, case-insensitive; unset
 *     refuses every tool call). There is no "*": one cap only makes sense for currencies of similar value.
 * While the operation's own opt-in env is not "1" the cap is not checked, so the layer's refusal names that env.
 * Workflow nodes are unaffected. This file is identical in stripe, midtrans, xendit and paypal; keep it so.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

/**
 * Returns the definition with tool calls of `operationNames` refused when their amount is over the cap.
 *
 * @param pluginDefinition - Plugin definition from defineRestPlugin (object)
 * @param policy - Cap policy (object)
 * @param policy.operationNames - Operations to cap (string[])
 * @param policy.maxAmountEnv - Env holding the maximum total per call, e.g. "STRIPE_TOOL_MAX_AMOUNT" (string)
 * @param policy.currencyEnv - Env holding the allowed currencies; omit for single-currency APIs (string, optional)
 * @param policy.readCharges - `(args) => [{amount, currency?}]`, the call's amounts; an empty list is refused (function)
 * @param policy.unitLabel - How amounts are counted, for messages, e.g. "smallest currency unit" (string)
 * @returns A new definition; restSpec and the other operations are unchanged (object)
 *
 * @example
 * capToolAmounts(definition, { operationNames: ["create_payment_intent"], maxAmountEnv: "STRIPE_TOOL_MAX_AMOUNT",
 *   currencyEnv: "STRIPE_TOOL_ALLOWED_CURRENCIES", readCharges: (args) => [{ amount: args.amount, currency: args.currency }],
 *   unitLabel: "smallest currency unit" });
 */
export function capToolAmounts(pluginDefinition, policy) {
  const capped = new Set(policy.operationNames);
  const optInEnvByName = listOptInEnvs(pluginDefinition);
  const wrapOperation = (operation) => {
    if (!capped.has(operation.name)) return operation;
    const run = (context) => {
      const optInEnv = optInEnvByName.get(operation.name);
      const optedIn = optInEnv === undefined || context.environment?.[optInEnv] === "1";
      if (context.source === "tool" && optedIn) assertWithinCap(operation.name, policy.readCharges(context.args ?? {}), context.environment ?? {}, policy);
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

/**
 * Parses the cap env value.
 *
 * @param envValue - e.g. "50000" (string, optional)
 * @returns The cap, or undefined when unset, not a number, or not positive (number | undefined)
 */
export function parseMaxAmount(envValue) {
  const text = String(envValue ?? "").trim();
  if (text === "") return undefined;
  const maxAmount = Number(text);
  return Number.isFinite(maxAmount) && maxAmount > 0 ? maxAmount : undefined;
}

function listOptInEnvs(pluginDefinition) {
  const operations = pluginDefinition.restSpec?.operations ?? [];
  return new Map(operations.filter((operation) => operation.toolPolicy).map((operation) => [operation.name, operation.toolPolicy.replace(/^optIn:/, "")]));
}

function refuse(operationName, problem) {
  throw new PluginError(`\`${operationName}\` as an agent tool: ${problem}; use a workflow node for larger or other payments`, { kind: "permission_denied" });
}

function assertWithinCap(operationName, charges, environment, { maxAmountEnv, currencyEnv, unitLabel }) {
  const maxAmount = parseMaxAmount(environment[maxAmountEnv]);
  if (maxAmount === undefined) refuse(operationName, `set ${maxAmountEnv} to the maximum amount per call (${unitLabel}); it is unset or 0, so every amount is refused`);
  if (!Array.isArray(charges) || charges.length === 0) refuse(operationName, "the amount could not be read from the arguments");
  const total = charges.reduce((sum, charge) => sum + readAmount(operationName, charge.amount), 0);
  if (total > maxAmount) refuse(operationName, `amount ${total} is over ${maxAmountEnv}=${maxAmount} (${unitLabel})`);
  if (currencyEnv) assertCurrenciesAllowed(operationName, charges, environment[currencyEnv], currencyEnv);
}

function readAmount(operationName, rawAmount) {
  const amount = typeof rawAmount === "number" ? rawAmount : typeof rawAmount === "string" && rawAmount.trim() !== "" ? Number(rawAmount) : Number.NaN;
  if (!Number.isFinite(amount) || amount <= 0) refuse(operationName, `amount ${JSON.stringify(rawAmount)} is not a positive number`);
  return amount;
}

function assertCurrenciesAllowed(operationName, charges, envValue, currencyEnv) {
  const allowedCurrencies = String(envValue ?? "")
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
  for (const { currency } of charges) {
    const normalizedCurrency = String(currency ?? "").trim().toUpperCase();
    if (!normalizedCurrency || !allowedCurrencies.includes(normalizedCurrency)) {
      refuse(operationName, `currency ${JSON.stringify(currency ?? null)} is not listed in ${currencyEnv}`);
    }
  }
}
