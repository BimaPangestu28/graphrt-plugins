/**
 * Stripe argument checks around the declarative definition:
 * - normalizeCurrencyArguments: `currency` is trimmed and lowercased on every call (Stripe's documented form), so
 *   the cap's currency allowlist and Stripe see the same code.
 * - limitToolLineItems: agent payment links may only list existing prices as `{price, quantity}` with a quantity of
 *   at most MAX_TOOL_LINE_ITEM_QUANTITY; `price_data`, `adjustable_quantity` and any other key are refused (they
 *   would let an agent set an arbitrary amount or let the buyer raise the quantity). Checked once the operation's
 *   opt-in env is "1", so a refusal without it still names the opt-in. Workflow nodes are unaffected.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const MAX_TOOL_LINE_ITEM_QUANTITY = 100;
const LINE_ITEM_KEYS = new Set(["price", "quantity"]);

/**
 * Returns the definition with `currency` trimmed and lowercased on the operations that have that param.
 *
 * @param pluginDefinition - Plugin definition from defineRestPlugin (object)
 * @returns A new definition (object)
 */
export function normalizeCurrencyArguments(pluginDefinition) {
  const currencyOperations = new Set((pluginDefinition.restSpec?.operations ?? []).filter((operation) => "currency" in operation.params).map((operation) => operation.name));
  const wrapOperation = (operation) => {
    if (!currencyOperations.has(operation.name)) return operation;
    const run = (context) => {
      const currency = context.args?.currency;
      if (typeof currency !== "string") return operation.run(context);
      return operation.run({ ...context, args: { ...context.args, currency: currency.trim().toLowerCase() } });
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

/**
 * Checks agent line items: only `{price, quantity}`, a price id and 1 <= quantity <= MAX_TOOL_LINE_ITEM_QUANTITY.
 *
 * @param lineItems - Tool argument (any)
 * @throws PluginError kind `permission_denied` - Any other key or value
 */
export function assertToolLineItems(lineItems) {
  const refuse = (problem) => {
    throw new PluginError(`create_payment_link as an agent tool: ${problem}; use a workflow node`, { kind: "permission_denied" });
  };
  if (!Array.isArray(lineItems)) refuse("line_items must be a list");
  lineItems.forEach((lineItem, index) => {
    if (!lineItem || typeof lineItem !== "object" || Array.isArray(lineItem)) refuse(`line_items[${index}] must be an object`);
    const unknownKey = Object.keys(lineItem).find((key) => !LINE_ITEM_KEYS.has(key));
    if (unknownKey) refuse(`line_items[${index}].${unknownKey} is not allowed (only price and quantity)`);
    if (typeof lineItem.price !== "string" || !lineItem.price.startsWith("price_")) refuse(`line_items[${index}].price must be an existing price id (price_...)`);
    const quantity = lineItem.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_TOOL_LINE_ITEM_QUANTITY) refuse(`line_items[${index}].quantity must be an integer from 1 to ${MAX_TOOL_LINE_ITEM_QUANTITY}`);
  });
}

/**
 * Returns the definition with agent payment-link line items checked by assertToolLineItems.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param optInEnv - The operation's opt-in env, e.g. "STRIPE_TOOL_ALLOW_PAYMENT_LINKS" (string)
 * @returns A new definition (object)
 */
export function limitToolLineItems(pluginDefinition, optInEnv) {
  const wrapOperation = (operation) => {
    if (operation.name !== "create_payment_link") return operation;
    const run = (context) => {
      if (context.source === "tool" && context.environment?.[optInEnv] === "1") assertToolLineItems(context.args?.line_items);
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
