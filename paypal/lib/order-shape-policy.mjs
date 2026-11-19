/**
 * Shape checks for PayPal orders and invoices created by agent tools, on top of the amount cap.
 *
 * Purchase units are free-form objects, and some keys move money elsewhere: `payee` pays another merchant account,
 * `payment_instruction.platform_fees[].payee` sends a fee to one. So for tool calls every object inside
 * `purchase_units` is checked against an ALLOWLIST of keys, recursively (amount, breakdown, items, shipping); an
 * unknown key is refused rather than guessed at. Money values must be plain decimal strings ("10.50").
 *
 * For every call (nodes too) currency codes are trimmed and uppercased, and return/cancel URLs must be https; tool
 * calls also need their host in PAYPAL_TOOL_ALLOWED_RETURN_HOSTS when that env is set. Tool checks run only once the
 * operation's opt-in env is "1", so a refusal without it still names the opt-in.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const MONEY_VALUE_PATTERN = /^\d+(\.\d{1,3})?$/;
const MONEY_SHAPE = { currency_code: "text", value: "money" };
const BREAKDOWN_SHAPE = Object.fromEntries(["item_total", "shipping", "handling", "tax_total", "insurance", "shipping_discount", "discount"].map((key) => [key, MONEY_SHAPE]));
const ITEM_SHAPE = { name: "text", quantity: "text", description: "text", sku: "text", category: "text", unit_amount: MONEY_SHAPE, tax: MONEY_SHAPE };
const ADDRESS_SHAPE = Object.fromEntries(["address_line_1", "address_line_2", "admin_area_1", "admin_area_2", "postal_code", "country_code"].map((key) => [key, "text"]));
const SHIPPING_SHAPE = { type: "text", name: { full_name: "text" }, address: ADDRESS_SHAPE };
export const PURCHASE_UNIT_SHAPE = {
  reference_id: "text",
  description: "text",
  custom_id: "text",
  invoice_id: "text",
  soft_descriptor: "text",
  amount: { ...MONEY_SHAPE, breakdown: BREAKDOWN_SHAPE },
  items: [ITEM_SHAPE],
  shipping: SHIPPING_SHAPE,
};
export const INVOICE_ITEM_SHAPE = { name: "text", quantity: "text", description: "text", unit_of_measure: "text", unit_amount: MONEY_SHAPE };

function refuse(message) {
  throw new PluginError(`${message}; use a workflow node for anything else`, { kind: "permission_denied" });
}

/**
 * Checks a value against a shape: "text" (string or number), "money" (decimal string), an object shape (only its
 * keys) or a one-element array shape (every item).
 *
 * @param value - Value from the tool call (any)
 * @param shape - Shape (string | object | Array)
 * @param location - Path for messages, e.g. "purchase_units[0]" (string)
 * @throws PluginError kind `permission_denied` - Unknown key, wrong type, or a money value that is not decimal
 */
export function assertShape(value, shape, location) {
  if (shape === "text") {
    if (typeof value !== "string" && typeof value !== "number") refuse(`${location} must be text`);
    return;
  }
  if (shape === "money") {
    if (typeof value !== "string" || !MONEY_VALUE_PATTERN.test(value)) refuse(`${location} must be a decimal string like "10.50"`);
    return;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) refuse(`${location} must be a list`);
    value.forEach((item, index) => assertShape(item, shape[0], `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(`${location} must be an object`);
  for (const [key, nestedValue] of Object.entries(value)) {
    if (!Object.hasOwn(shape, key)) refuse(`${location}.${key} is not allowed for agent tools`);
    assertShape(nestedValue, shape[key], `${location}.${key}`);
  }
}

/**
 * Returns a copy with every `currency_code` / `currency` string trimmed and uppercased, at any depth.
 *
 * @param value - Arguments (any)
 * @returns Normalized copy (any)
 *
 * @example
 * normalizeCurrencies({ amount: { currency_code: " usd ", value: "1.00" } }); // { amount: { currency_code: "USD", value: "1.00" } }
 */
export function normalizeCurrencies(value) {
  if (Array.isArray(value)) return value.map(normalizeCurrencies);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      (key === "currency_code" || key === "currency") && typeof nestedValue === "string" ? nestedValue.trim().toUpperCase() : normalizeCurrencies(nestedValue),
    ]),
  );
}

function assertReturnUrl(argumentName, rawUrl, allowedHosts) {
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new PluginError(`\`${argumentName}\` must be an https URL`, { kind: "invalid_input" });
  }
  if (parsedUrl.protocol !== "https:") throw new PluginError(`\`${argumentName}\` must be an https URL`, { kind: "invalid_input" });
  if (allowedHosts && !allowedHosts.includes(parsedUrl.hostname.toLowerCase())) refuse(`\`${argumentName}\` host ${parsedUrl.hostname} is not listed in PAYPAL_TOOL_ALLOWED_RETURN_HOSTS`);
}

function parseHosts(envValue) {
  const hosts = String(envValue ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  return hosts.length > 0 ? hosts : undefined;
}

/**
 * Returns the definition with currencies normalized on `create_order` and `create_invoice`, https return URLs,
 * and (tool calls) the purchase-unit and invoice-item allowlists.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @returns A new definition (object)
 */
export function guardPayPalShapes(pluginDefinition) {
  const checks = {
    create_order: (args, isTool, environment) => {
      const allowedHosts = isTool ? parseHosts(environment.PAYPAL_TOOL_ALLOWED_RETURN_HOSTS) : undefined;
      for (const argumentName of ["return_url", "cancel_url"]) if (args[argumentName] !== undefined) assertReturnUrl(argumentName, args[argumentName], allowedHosts);
      if (isTool) assertShape(args.purchase_units, [PURCHASE_UNIT_SHAPE], "purchase_units");
    },
    create_invoice: (args, isTool) => {
      if (isTool && args.items !== undefined) assertShape(args.items, [INVOICE_ITEM_SHAPE], "items");
    },
  };
  const optInEnvByName = new Map((pluginDefinition.restSpec?.operations ?? []).filter((operation) => operation.toolPolicy).map((operation) => [operation.name, operation.toolPolicy.replace(/^optIn:/, "")]));
  const wrapOperation = (operation) => {
    const check = checks[operation.name];
    if (!check) return operation;
    const run = (context) => {
      const args = normalizeCurrencies(context.args ?? {});
      const environment = context.environment ?? {};
      const optInEnv = optInEnvByName.get(operation.name);
      // While the opt-in is off the layer refuses the tool call itself, naming the env.
      const isCheckedTool = context.source === "tool" && (optInEnv === undefined || environment[optInEnv] === "1");
      check(args, isCheckedTool, environment);
      return operation.run({ ...context, args });
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
