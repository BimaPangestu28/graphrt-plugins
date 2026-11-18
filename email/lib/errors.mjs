/**
 * PluginError builders and secret redaction for the email plugin.
 *
 * nodemailer and imapflow error messages can quote server responses, and an
 * SMTP AUTH exchange carries the password base64-encoded, so every error that
 * leaves the plugin goes through a redactor built from the account password.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const REDACTED = "[redacted]";
// Shorter secrets would mangle ordinary words in messages; a real password is never this short.
const MIN_REDACTABLE_LENGTH = 3;

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
 * Builds a `not_found` error (unknown mailbox, message uid or local file).
 *
 * @param message - What was not found (string)
 * @returns PluginError kind `not_found`
 */
export function notFound(message) {
  return new PluginError(message, { kind: "not_found" });
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
 * Builds the `cancelled` error used when the host cancels or a tool deadline passes.
 *
 * @param detail - Extra sentence, e.g. what may already have happened (string, optional)
 * @returns PluginError kind `cancelled`, not retryable
 */
export function cancelled(detail = "") {
  return new PluginError(`Email operation cancelled${detail ? `: ${detail}` : ""}`, { kind: "cancelled" });
}

/**
 * Lists the forms a password can take on the wire or in a library message:
 * as is, without spaces (Gmail shows app passwords in groups of four),
 * IMAP-quoted (LOGIN sends `"` and `\` escaped with a backslash), and
 * base64-encoded the way AUTH PLAIN and AUTH LOGIN send it.
 *
 * @param credentials - `{user, password}` (object)
 * @returns Secret strings to redact (string[])
 */
export function buildSecretVariants({ user = "", password }) {
  if (!password) return [];
  const passwordForms = [...new Set([password, password.replace(/\s+/g, "")])];
  const imapQuotedForms = passwordForms.map((form) => form.replace(/[\\"]/g, "\\$&"));
  const toBase64 = (text) => Buffer.from(text, "utf8").toString("base64");
  const encodedForms = passwordForms.flatMap((form) => [toBase64(form), toBase64(`\u0000${user}\u0000${form}`), toBase64(`${user}\u0000${user}\u0000${form}`)]);
  return [...new Set([...passwordForms, ...imapQuotedForms, ...encodedForms])].filter((secret) => secret.length >= MIN_REDACTABLE_LENGTH);
}

/**
 * Creates a function that replaces every secret in a text with "[redacted]".
 *
 * @param secrets - Strings to hide (string[])
 * @returns `(text) => redactedText` (function)
 *
 * @example
 * const redact = createRedactor(buildSecretVariants({ user, password }));
 * redact(`535 bad password ${password}`); // "535 bad password [redacted]"
 */
export function createRedactor(secrets) {
  const longestFirst = [...new Set(secrets)].filter(Boolean).sort((left, right) => right.length - left.length);
  return (text) => {
    let redactedText = String(text ?? "");
    for (const secret of longestFirst) redactedText = redactedText.split(secret).join(REDACTED);
    return redactedText;
  };
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
  return new PluginError(`Email plugin failed: ${redact(error?.message ?? error)}`, { kind: "plugin_error" });
}

/**
 * Reports a missing npm dependency as `setup_required`.
 *
 * @param packageName - "nodemailer" or "imapflow" (string)
 * @param importError - The failed import's error (Error)
 * @returns PluginError kind `setup_required`, or the original error when it is something else
 */
export function classifyImportError(packageName, importError) {
  const isMissing = importError?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(importError?.message ?? "");
  if (!isMissing) return importError;
  return setupRequired(`The ${packageName} package is not installed: run \`npm install\` in the email plugin directory`);
}
