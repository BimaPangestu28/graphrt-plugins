/**
 * PluginError builders and secret redaction for the SQL plugins.
 *
 * Driver messages can quote a connection string (with its password), so every
 * error that leaves the plugin goes through a redactor built from the
 * connection's secrets. This file is identical in the postgres, mysql and
 * sqlite plugins; keep the copies in step.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const REDACTED = "[redacted]";
// Shorter secrets would mangle ordinary words in messages; a real password is never this short.
const MIN_REDACTABLE_LENGTH = 3;
// `scheme://user:password@host` — hides the password of any URL-shaped text, known or not.
const URL_PASSWORD_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^:/?#@\s]*:)[^@/?#\s]*@/gi;

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
 * Builds a `setup_required` error (missing configuration or npm dependencies).
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
 * @param detail - Extra sentence, e.g. whether a write may have been applied (string, optional)
 * @returns PluginError kind `cancelled`, not retryable
 */
export function cancelled(detail = "") {
  return new PluginError(`Database operation cancelled${detail ? `: ${detail}` : ""}`, { kind: "cancelled" });
}

/**
 * Creates a function that replaces every secret, and the password of any URL, with "[redacted]".
 *
 * @param secrets - Strings to hide, e.g. the password and the full connection URL (string[])
 * @returns `(text) => redactedText` (function)
 *
 * @example
 * const redact = createRedactor(["s3cret"]);
 * redact("password authentication failed: s3cret"); // "password authentication failed: [redacted]"
 */
export function createRedactor(secrets) {
  const longestFirst = [...new Set(secrets.flatMap(expandSecretForms))]
    .filter((secret) => secret.length >= MIN_REDACTABLE_LENGTH)
    .sort((left, right) => right.length - left.length);
  return (text) => {
    let redactedText = String(text ?? "");
    for (const secret of longestFirst) redactedText = redactedText.split(secret).join(REDACTED);
    return redactedText.replace(URL_PASSWORD_PATTERN, `$1${REDACTED}@`);
  };
}

// A password can appear as typed or percent-encoded inside a URL.
function expandSecretForms(secret) {
  if (typeof secret !== "string" || secret === "") return [];
  return [secret, encodeURIComponent(secret)];
}

/**
 * Returns a PluginError with a redacted message; other errors become `plugin_error`.
 *
 * @param error - Any thrown value (unknown)
 * @param redact - From createRedactor (function)
 * @returns PluginError with the same kind, retryable flag and retry delay (PluginError)
 */
export function redactError(error, redact) {
  if (error instanceof PluginError) {
    return new PluginError(redact(error.message), { kind: error.kind, retryable: error.retryable, retryAfterMs: error.retryAfterMs });
  }
  return new PluginError(`Database plugin failed: ${redact(error?.message ?? error)}`, { kind: "plugin_error" });
}

/**
 * Reports a missing npm dependency as `setup_required`.
 *
 * @param packageName - The npm package that failed to load, e.g. "pg" (string)
 * @param pluginName - Plugin directory to run `npm install` in (string)
 * @param importError - The failed import's error (Error)
 * @returns PluginError kind `setup_required`, or the original error when it is something else
 */
export function classifyImportError(packageName, pluginName, importError) {
  const isMissing = importError?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(importError?.message ?? "");
  if (!isMissing) return importError;
  return setupRequired(`The ${packageName} package is not installed: run \`npm install\` in the ${pluginName} plugin directory`);
}
