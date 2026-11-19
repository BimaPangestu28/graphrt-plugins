/**
 * Argument limits for agent-tool calls of opt-in writes, on top of the layer's `toolPolicy`:
 * - refuseToolArguments: arguments agents may never pass (prices and stock: the same ruling as Shopee and Lazada
 *   marketplaces, where price and stock changes are node only).
 * - limitToolEnum: an enum argument agents may only set to some values (order statuses that do not cancel,
 *   refund or fail an order).
 * While the operation's own opt-in env is not "1" nothing is checked, so the layer's refusal names that env.
 * Workflow nodes are unaffected.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

function listOptInEnvs(pluginDefinition) {
  const operations = pluginDefinition.restSpec?.operations ?? [];
  return new Map(operations.filter((operation) => operation.toolPolicy).map((operation) => [operation.name, operation.toolPolicy.replace(/^optIn:/, "")]));
}

function wrapToolCalls(pluginDefinition, operationNames, checkArguments) {
  const restricted = new Set(operationNames);
  const optInEnvByName = listOptInEnvs(pluginDefinition);
  const wrapOperation = (operation) => {
    if (!restricted.has(operation.name)) return operation;
    const run = (context) => {
      const optInEnv = optInEnvByName.get(operation.name);
      const optedIn = optInEnv === undefined || context.environment?.[optInEnv] === "1";
      if (context.source === "tool" && optedIn) checkArguments(operation.name, context.args ?? {});
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

/**
 * Returns the definition with tool calls refused when they pass any of `argumentNames`.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param policy - `{operationNames: string[], argumentNames: string[], reason: string}` (object)
 * @returns A new definition (object)
 *
 * @example
 * refuseToolArguments(def, { operationNames: ["update_product"], argumentNames: ["regular_price"], reason: "prices are node only" });
 */
export function refuseToolArguments(pluginDefinition, { operationNames, argumentNames, reason }) {
  return wrapToolCalls(pluginDefinition, operationNames, (operationName, args) => {
    const refusedName = argumentNames.find((argumentName) => args[argumentName] !== undefined);
    if (refusedName) throw new PluginError(`\`${refusedName}\` is not allowed for agent tools in \`${operationName}\`: ${reason}`, { kind: "permission_denied" });
  });
}

/**
 * Returns the definition with tool calls refused when `argumentName` is not one of `allowedValues`.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param policy - `{operationNames: string[], argumentName: string, allowedValues: string[], reason: string}` (object)
 * @returns A new definition (object)
 */
export function limitToolEnum(pluginDefinition, { operationNames, argumentName, allowedValues, reason }) {
  return wrapToolCalls(pluginDefinition, operationNames, (operationName, args) => {
    if (args[argumentName] === undefined || allowedValues.includes(args[argumentName])) return;
    throw new PluginError(`\`${operationName}\` as an agent tool may only set ${argumentName} to ${allowedValues.join(", ")}: ${reason}`, { kind: "permission_denied" });
  });
}
