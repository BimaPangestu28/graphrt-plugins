/**
 * Reads and validates the plugin's environment variables.
 */
import { invalidInput } from "./errors.mjs";

export const REDIS_URL_ENV = "REDIS_URL";
export const SETTINGS_ENV = [
  "REDIS_KEY_PREFIX",
  "REDIS_TOOL_ALLOW_WRITES",
  "REDIS_MAX_VALUE_BYTES",
  "REDIS_MAX_RESULT_BYTES",
  "REDIS_COMMAND_TIMEOUT_MS",
  "REDIS_IDLE_MINUTES",
];

const MEBIBYTE = 1024 * 1024;
const URL_SCHEMES = /^rediss?:\/\//i;
const MAX_PREFIX_BYTES = 256;

/**
 * Builds the settings for one operation.
 *
 * @param environment - Environment variables (object)
 * @param connectionUrl - REDIS_URL or the node's `access_token` (string)
 * @returns `{connectionUrl, keyPrefix, toolWritesAllowed, maxValueBytes, maxResultBytes, commandTimeoutMs, idleTimeoutMs}` (object)
 * @throws PluginError kind `invalid_input` - When the URL scheme, prefix or a number is invalid
 *
 * @example
 * resolveSettings({ REDIS_KEY_PREFIX: "shop:" }, "redis://127.0.0.1:6379/0").keyPrefix; // "shop:"
 */
export function resolveSettings(environment, connectionUrl) {
  if (!URL_SCHEMES.test(connectionUrl)) throw invalidInput("The Redis URL must start with redis:// or rediss://");
  return {
    connectionUrl,
    keyPrefix: readPrefix(environment?.REDIS_KEY_PREFIX),
    toolWritesAllowed: String(environment?.REDIS_TOOL_ALLOW_WRITES ?? "").trim() === "1",
    maxValueBytes: readInteger(environment?.REDIS_MAX_VALUE_BYTES, "REDIS_MAX_VALUE_BYTES", MEBIBYTE, 1, 64 * MEBIBYTE),
    maxResultBytes: readInteger(environment?.REDIS_MAX_RESULT_BYTES, "REDIS_MAX_RESULT_BYTES", 4 * MEBIBYTE, 1024, 8 * MEBIBYTE),
    commandTimeoutMs: readInteger(environment?.REDIS_COMMAND_TIMEOUT_MS, "REDIS_COMMAND_TIMEOUT_MS", 10_000, 100, 60_000),
    idleTimeoutMs: readInteger(environment?.REDIS_IDLE_MINUTES, "REDIS_IDLE_MINUTES", 5, 1, 24 * 60) * 60_000,
  };
}

// The prefix is used exactly as given (no trimming), so "tenant-a:" stays "tenant-a:".
function readPrefix(rawPrefix) {
  if (rawPrefix === undefined || rawPrefix === null || rawPrefix === "") return "";
  const prefix = String(rawPrefix);
  if (Buffer.byteLength(prefix) > MAX_PREFIX_BYTES || /[\u0000-\u001f\s]/.test(prefix)) {
    throw invalidInput(`REDIS_KEY_PREFIX must be at most ${MAX_PREFIX_BYTES} bytes without spaces or control characters`);
  }
  return prefix;
}

function readInteger(rawValue, variableName, defaultValue, minimum, maximum) {
  const text = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!text) return defaultValue;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalidInput(`${variableName} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}
