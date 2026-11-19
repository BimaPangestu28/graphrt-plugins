/**
 * Turns ssh2 and SFTP failures into PluginErrors with stable kinds, with
 * every secret redacted from the message.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const SFTP_STATUS_KINDS = { 2: "not_found", 3: "permission_denied" };
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);
const REDACTED = "[redacted]";

/**
 * Creates a function that replaces each secret (and its first line, for multi-line keys) with "[redacted]".
 *
 * @param secrets - Password, private key, passphrase (string[])
 * @returns `(text) => redactedText` (function)
 */
export function createRedactor(secrets) {
  const forms = [...new Set(secrets.flatMap((secret) => [secret, ...String(secret).split("\n").map((line) => line.trim())]))]
    .filter((form) => form.length >= 6 && !/^-----(BEGIN|END) /.test(form))
    .sort((left, right) => right.length - left.length);
  return (text) => forms.reduce((redactedText, form) => redactedText.split(form).join(REDACTED), String(text ?? ""));
}

/**
 * Maps a failure.
 *
 * @param error - Thrown value (unknown)
 * @param context - `{redact, rejectedFingerprint}` (object)
 * @returns PluginError (PluginError)
 */
export function mapSftpError(error, { redact, rejectedFingerprint }) {
  if (error instanceof PluginError) return new PluginError(redact(error.message), { kind: error.kind, retryable: error.retryable });
  const message = redact(error?.message ?? String(error));
  if (rejectedFingerprint) {
    return new PluginError(`The server's host key ${rejectedFingerprint} is not in SFTP_HOST_FINGERPRINT; the connection was refused. Check the key out of band before adding it`, { kind: "auth_error" });
  }
  if (error?.level === "client-authentication") return new PluginError(`SFTP authentication failed: ${message}`, { kind: "auth_error" });
  if (error?.level === "client-timeout") return new PluginError(`SFTP connection timed out: ${message}`, { kind: "network_error", retryable: true });
  if (NETWORK_CODES.has(error?.code) || error?.level === "client-socket") return new PluginError(`SFTP network error: ${message}`, { kind: "network_error", retryable: true });
  if (typeof error?.code === "number") return new PluginError(`SFTP server: ${message}`, { kind: SFTP_STATUS_KINDS[error.code] ?? "plugin_error" });
  return new PluginError(`SFTP failed: ${message}`, { kind: "plugin_error" });
}
