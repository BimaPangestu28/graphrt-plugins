/**
 * Refuses update calls that would change nothing: at least one of the listed arguments must be given. An empty
 * update is usually an agent or template mistake (e.g. a blank field dropped as missing), and the API would either
 * reject it or silently do nothing. This file is identical in jira and linear; keep it so.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

/**
 * Returns the definition with `operationName` refused unless one of `argumentNames` is set.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param policy - `{operationName: string, argumentNames: string[]}` (object)
 * @returns A new definition (object)
 * @throws Error - The operation does not exist
 *
 * @example
 * requireSomeArguments(definition, { operationName: "update_issue", argumentNames: ["summary", "labels"] });
 */
export function requireSomeArguments(pluginDefinition, { operationName, argumentNames }) {
  if (!pluginDefinition.operations.some((operation) => operation.name === operationName)) throw new Error(`${pluginDefinition.name}: requireSomeArguments: no operation ${operationName}`);
  const wrapOperation = (operation) => {
    if (operation.name !== operationName) return operation;
    const run = (context) => {
      if (!argumentNames.some((argumentName) => context.args?.[argumentName] !== undefined)) {
        throw new PluginError(`\`${operationName}\` needs at least one field to change: ${argumentNames.join(", ")}`, { kind: "invalid_input" });
      }
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
