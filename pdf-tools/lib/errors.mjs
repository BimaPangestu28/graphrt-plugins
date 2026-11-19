/**
 * PluginError builders for the local file plugins.
 * This file is identical in the ffmpeg, image-tools, pdf-tools, excel-csv,
 * ocr-tesseract, qr-code, local-files, sftp, macos-notifications, file-watcher
 * and shell-exec plugins; keep the copies in step.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

/**
 * Builds an `invalid_input` error.
 *
 * @param message - What is wrong (string)
 * @returns PluginError kind `invalid_input`
 */
export function invalidInput(message) {
  return new PluginError(message, { kind: "invalid_input" });
}

/**
 * Builds a `setup_required` error (missing configuration, binary or npm dependency).
 *
 * @param message - What to set up (string)
 * @returns PluginError kind `setup_required`
 */
export function setupRequired(message) {
  return new PluginError(message, { kind: "setup_required" });
}

/**
 * Builds a `permission_denied` error (a tool call asked for something only nodes may do).
 *
 * @param message - What was refused and how to allow it (string)
 * @returns PluginError kind `permission_denied`
 */
export function permissionDenied(message) {
  return new PluginError(message, { kind: "permission_denied" });
}

/**
 * Builds a `not_found` error.
 *
 * @param message - What was not found (string)
 * @returns PluginError kind `not_found`
 */
export function notFound(message) {
  return new PluginError(message, { kind: "not_found" });
}

/**
 * Builds the `cancelled` error used when the host cancels or a tool deadline passes.
 *
 * @param what - What was stopped, e.g. "ffmpeg" (string)
 * @returns PluginError kind `cancelled`
 */
export function cancelled(what) {
  return new PluginError(`${what} was cancelled; no output was kept`, { kind: "cancelled" });
}

/**
 * Builds a `timeout` error.
 *
 * @param what - What ran too long (string)
 * @param timeoutMs - The limit that passed (number)
 * @returns PluginError kind `timeout`
 */
export function timedOut(what, timeoutMs) {
  return new PluginError(`${what} exceeded the ${timeoutMs} ms timeout and was stopped; no output was kept`, { kind: "timeout" });
}

/**
 * Builds a `plugin_error` for a failed local operation (bad media, library failure).
 *
 * @param message - What failed (string)
 * @returns PluginError kind `plugin_error`
 */
export function operationFailed(message) {
  return new PluginError(message, { kind: "plugin_error" });
}

/**
 * Reports a missing npm dependency as `setup_required`.
 *
 * @param packageName - The npm package that failed to load, e.g. "sharp" (string)
 * @param pluginName - Plugin directory to run `npm install` in (string)
 * @param importError - The failed import's error (Error)
 * @returns PluginError kind `setup_required`, or the original error when it is something else
 */
export function classifyImportError(packageName, pluginName, importError) {
  const isMissing = importError?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(importError?.message ?? "");
  if (!isMissing) return importError;
  return setupRequired(`The ${packageName} package is not installed: run \`npm install\` in the ${pluginName} plugin directory`);
}

/**
 * Throws `cancelled` when the signal has already fired (checked between steps of in-process work).
 *
 * @param signal - AbortSignal (AbortSignal, optional)
 * @param what - What is being cancelled, for the message (string)
 * @throws PluginError kind `cancelled` - When the signal is aborted
 */
export function throwIfCancelled(signal, what) {
  if (signal?.aborted) throw cancelled(what);
}
