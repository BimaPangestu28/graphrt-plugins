/**
 * "Exactly one of these params" checks for declarative operations, which the REST spec cannot express. The check
 * runs before the operation's own run, so a bad call never sends a request.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

/**
 * Returns a copy of the definition where `operationName` refuses calls that set none or several of `paramNames`.
 *
 * @param pluginDefinition - Definition from defineRestPlugin (object)
 * @param operationName - Operation to guard (string)
 * @param paramNames - Params of which exactly one must be set (string[])
 * @returns The definition with the guarded operation (object)
 * @throws Error - When the operation does not exist
 *
 * @example
 * export const pluginDefinition = requireExactlyOne(restDefinition, "analyze_text", ["text", "url"]);
 */
export function requireExactlyOne(pluginDefinition, operationName, paramNames) {
  if (!pluginDefinition.operations.some((operation) => operation.name === operationName)) throw new Error(`requireExactlyOne: unknown operation ${operationName}`);
  const guardOperation = (operation) => ({
    ...operation,
    run: (context) => {
      assertExactlyOne(operationName, paramNames, context.args);
      return operation.run(context);
    },
  });
  return { ...pluginDefinition, operations: pluginDefinition.operations.map((operation) => (operation.name === operationName ? guardOperation(operation) : operation)) };
}

function assertExactlyOne(operationName, paramNames, args) {
  const givenNames = paramNames.filter((paramName) => args[paramName] !== undefined && args[paramName] !== "");
  if (givenNames.length === 1) return;
  const problem = givenNames.length === 0 ? "needs one of" : "takes only one of";
  throw new PluginError(`\`${operationName}\` ${problem} ${paramNames.map((paramName) => `\`${paramName}\``).join(" or ")}`, { kind: "invalid_input" });
}
