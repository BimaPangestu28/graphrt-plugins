/**
 * RajaOngkir answers an invalid or unknown key with HTTP 400 {"meta": {"message": "Invalid Api key, key not found",
 * "code": 400}}: no distinct status or code, so the shared client calls it invalid_input. This wrapper turns that
 * one message into auth_error so workflows and agents see a credential problem, not a bad argument.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const INVALID_KEY_PATTERN = /invalid api ?key/i;

/**
 * Whether an error is RajaOngkir's invalid-key answer.
 *
 * @param error - Error thrown by an operation (any)
 * @returns True for a PluginError whose message names an invalid API key (boolean)
 */
export function isInvalidKeyError(error) {
  return error instanceof PluginError && error.kind !== "auth_error" && INVALID_KEY_PATTERN.test(error.message);
}

/**
 * Returns the definition with invalid-key errors of every operation reported as auth_error.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @returns A new definition (object)
 */
export function mapInvalidKeyErrors(pluginDefinition) {
  const wrapOperation = (operation) => {
    const run = async (context) => {
      try {
        return await operation.run(context);
      } catch (operationError) {
        if (!isInvalidKeyError(operationError)) throw operationError;
        throw new PluginError(operationError.message, { kind: "auth_error", retryable: false });
      }
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
