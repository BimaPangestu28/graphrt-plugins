/**
 * Argument checks for every call (nodes and tools): `currency` is trimmed and uppercased (Xendit's codes are
 * uppercase, and the cap's currency allowlist compares the same value), and invoice redirect URLs must be https.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const REDIRECT_URL_ARGUMENTS = ["success_redirect_url", "failure_redirect_url"];

/**
 * Normalizes and checks one call's arguments.
 *
 * @param args - Operation arguments (object)
 * @returns Arguments with an uppercased currency (object)
 * @throws PluginError kind `invalid_input` - A redirect URL that is not https
 *
 * @example
 * normalizeXenditArguments({ currency: " idr " }); // { currency: "IDR" }
 */
export function normalizeXenditArguments(args) {
  for (const argumentName of REDIRECT_URL_ARGUMENTS) {
    if (args[argumentName] === undefined) continue;
    let redirectUrl;
    try {
      redirectUrl = new URL(args[argumentName]);
    } catch {
      redirectUrl = undefined;
    }
    if (redirectUrl?.protocol !== "https:") throw new PluginError(`\`${argumentName}\` must be an https URL`, { kind: "invalid_input" });
  }
  return typeof args.currency === "string" ? { ...args, currency: args.currency.trim().toUpperCase() } : args;
}

/**
 * Returns the definition with normalizeXenditArguments applied to every operation.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @returns A new definition (object)
 */
export function normalizeArguments(pluginDefinition) {
  const wrapOperation = (operation) => ({ ...operation, run: (context) => operation.run({ ...context, args: normalizeXenditArguments(context.args ?? {}) }) });
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
