/**
 * PluginError builders for the error kinds this plugin reports.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

/**
 * Builds an `invalid_input` error (bad URL, scheme, selector or option).
 *
 * @param message - What is wrong with the arguments (string)
 * @returns PluginError kind `invalid_input`
 */
export function invalidInput(message) {
  return new PluginError(message, { kind: "invalid_input" });
}

/**
 * Builds a `permission_denied` error: an internal host, or a robots.txt disallow.
 *
 * @param message - What was refused and why (string)
 * @returns PluginError kind `permission_denied`
 */
export function permissionDenied(message) {
  return new PluginError(message, { kind: "permission_denied" });
}

/**
 * Builds a `not_found` error (host name that does not resolve).
 *
 * @param message - What was not found (string)
 * @returns PluginError kind `not_found`
 */
export function notFound(message) {
  return new PluginError(message, { kind: "not_found" });
}

/**
 * Builds a retryable `network_error` (connection refused, reset, TLS failure).
 *
 * @param message - What failed (string)
 * @returns PluginError kind `network_error`
 */
export function networkError(message) {
  return new PluginError(message, { kind: "network_error", retryable: true });
}

/**
 * Builds a retryable `timeout` error.
 *
 * @param message - What timed out (string)
 * @returns PluginError kind `timeout`
 */
export function timeoutError(message) {
  return new PluginError(message, { kind: "timeout", retryable: true });
}

/**
 * Builds a `browser_error` naming the step that failed.
 *
 * @param stepName - Human name of the step, e.g. "read page" (string)
 * @param cause - Underlying error or message (Error | string)
 * @returns PluginError kind `browser_error`
 */
export function browserError(stepName, cause) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new PluginError(`Browser step \`${stepName}\` failed: ${detail.split("\n")[0]}`, { kind: "browser_error" });
}

/**
 * Builds the `cancelled` error used when the host cancels an operation.
 *
 * @returns PluginError kind `cancelled`
 */
export function cancelled() {
  return new PluginError("Web browser operation cancelled", { kind: "cancelled" });
}

/**
 * Builds the `setup_required` error for a missing Playwright install or Chromium download.
 *
 * @returns PluginError kind `setup_required`
 */
export function setupRequired() {
  return new PluginError(
    "Playwright or its Chromium is not installed. Run `npm install && npx playwright install chromium` in the web-browser plugin directory.",
    { kind: "setup_required" },
  );
}

/**
 * Classifies a Chromium launch failure.
 *
 * @param launchError - Error from `chromium.launch` or the playwright import (Error)
 * @returns PluginError kind `setup_required` or `browser_error`
 */
export function classifyLaunchError(launchError) {
  const message = String(launchError?.message ?? launchError);
  if (/Executable doesn't exist|Cannot find (module|package) 'playwright'|ERR_MODULE_NOT_FOUND|playwright install/i.test(message)) {
    return setupRequired();
  }
  return new PluginError(`Failed to start the browser: ${message.split("\n")[0]}`, { kind: "browser_error" });
}

/**
 * Re-throws plugin errors and wraps anything else as `browser_error` for the step.
 *
 * @param stepName - Human name of the step (string)
 * @param stepAction - Async work for the step (() => Promise<T>)
 * @returns Result of `stepAction` (Promise<T>)
 * @throws PluginError - Unchanged plugin errors, or kind `browser_error`
 */
export async function runStep(stepName, stepAction) {
  try {
    return await stepAction();
  } catch (stepError) {
    if (stepError instanceof PluginError) throw stepError;
    throw browserError(stepName, stepError);
  }
}
