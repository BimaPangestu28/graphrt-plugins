/**
 * PluginError builders for the error kinds this plugin reports.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

/**
 * Builds an `invalid_input` error.
 *
 * @param message - What is wrong with the arguments (string)
 * @returns PluginError kind `invalid_input`
 */
export function invalidInput(message) {
  return new PluginError(message, { kind: "invalid_input" });
}

/**
 * Builds a `not_found` error (unknown chat, number not on WhatsApp, missing file).
 *
 * @param message - What was not found (string)
 * @returns PluginError kind `not_found`
 */
export function notFound(message) {
  return new PluginError(message, { kind: "not_found" });
}

/**
 * Builds the `auth_error` returned whenever WhatsApp Web shows the QR login screen.
 *
 * @returns PluginError kind `auth_error`
 */
export function notLoggedIn() {
  return new PluginError(
    "WhatsApp Web is not logged in (the QR code screen is showing): run the `whatsapp-web.login` node once and scan the QR code with your phone",
    { kind: "auth_error" },
  );
}

/**
 * Builds a `browser_error` naming the step that failed.
 *
 * @param stepName - Human name of the step, e.g. "open chat" (string)
 * @param cause - Underlying error or message (Error | string)
 * @returns PluginError kind `browser_error`
 */
export function browserError(stepName, cause) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new PluginError(`WhatsApp Web step \`${stepName}\` failed: ${detail.split("\n")[0]}`, { kind: "browser_error" });
}

/**
 * Builds the `cancelled` error used when the host cancels an operation.
 *
 * @returns PluginError kind `cancelled`
 */
export function cancelled() {
  return new PluginError("WhatsApp Web operation cancelled", { kind: "cancelled" });
}

/**
 * Runs one browser step and reports any non-plugin failure as `browser_error` with the step name.
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
