/**
 * Removes secret-bearing fields from what agent tools see. Stripe PaymentIntents (and Checkout Sessions, SetupIntents)
 * carry a `client_secret` meant for one customer's browser only: it confirms the payment. An agent that sees it can
 * leak it into chats or logs.
 *
 * The plugin must set `toolOutput: false` in its spec so the layer does not truncate (and so copy secrets into a
 * preview string) before the fields are removed; this wrapper truncates afterwards with the layer's defaults.
 * Workflow nodes get everything.
 */
import { DEFAULT_TOOL_OUTPUT, truncateForTool } from "./shared/rest-response.mjs";

/**
 * Removes every key named in `fieldNames`, at any depth.
 *
 * @param value - API data (any)
 * @param fieldNames - Keys to drop (Set<string>)
 * @returns A copy without those keys (any)
 *
 * @example
 * stripFields({ id: "pi_1", client_secret: "pi_1_secret_x" }, new Set(["client_secret"])); // { id: "pi_1" }
 */
export function stripFields(value, fieldNames) {
  if (Array.isArray(value)) return value.map((item) => stripFields(item, fieldNames));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !fieldNames.has(key))
      .map(([key, entryValue]) => [key, stripFields(entryValue, fieldNames)]),
  );
}

/**
 * Returns the definition with `fieldNames` removed from every operation's data for agent tools (api_request too),
 * then truncated like any tool result.
 *
 * @param pluginDefinition - Definition from defineRestPlugin with `toolOutput: false` (object)
 * @param fieldNames - Keys to drop at any depth, e.g. ["client_secret"] (string[])
 * @returns A new definition (object)
 * @throws Error - The spec still lets the layer truncate tool output
 */
export function stripSecretFieldsForTools(pluginDefinition, fieldNames) {
  if (pluginDefinition.restSpec?.toolOutput !== false) throw new Error(`${pluginDefinition.name}: stripSecretFieldsForTools needs toolOutput: false in the spec`);
  const secretFields = new Set(fieldNames);
  const wrapOperation = (operation) => ({
    ...operation,
    run: async (context) => {
      const result = await operation.run(context);
      if (context.source !== "tool") return result;
      return { ...result, data: truncateForTool(stripFields(result?.data, secretFields), DEFAULT_TOOL_OUTPUT) };
    },
  });
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
