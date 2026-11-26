/** Errors of the meeting-notes plugin. */
import { PluginError } from "./shared/graphrt-plugin.mjs";

/**
 * @param kind - PluginError kind, e.g. `invalid_input`, `not_found`, `api_error` (string)
 * @param message - Message safe to show (string)
 * @param options - `{retryable}` (object, optional)
 * @returns PluginError (PluginError)
 */
export function pluginError(kind, message, options = {}) {
  return new PluginError(message, { kind, retryable: options.retryable ?? false });
}

export const invalidInput = (message) => pluginError("invalid_input", message);
