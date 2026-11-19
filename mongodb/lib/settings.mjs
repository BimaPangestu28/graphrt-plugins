/**
 * Reads and validates the plugin's environment variables.
 */
import { invalidInput } from "./errors.mjs";
import { validateDatabaseName } from "./query-guard.mjs";

export const MONGODB_URL_ENV = "MONGODB_URL";
export const SETTINGS_ENV = ["MONGODB_DATABASE", "MONGODB_TOOL_ALLOW_WRITES", "MONGODB_TOOL_ALLOWED_DATABASES", "MONGODB_MAX_RESULT_BYTES", "MONGODB_IDLE_MINUTES"];

const DEFAULT_MAX_RESULT_BYTES = 1_000_000;
const MAX_RESULT_BYTES_LIMIT = 8_000_000;
const DEFAULT_IDLE_MINUTES = 5;
const CONNECTION_SCHEMES = /^mongodb(\+srv)?:\/\//i;

/**
 * Builds the settings for one operation.
 *
 * @param environment - Environment variables (object)
 * @param connectionUrl - MONGODB_URL or the node's `access_token` (string)
 * @returns `{connectionUrl, defaultDatabase, toolWritesAllowed, toolAllowedDatabases, maxResultBytes, idleTimeoutMs}` (object)
 * @throws PluginError kind `invalid_input` - When the URL scheme or a number is invalid
 *
 * @example
 * resolveSettings({ MONGODB_TOOL_ALLOW_WRITES: "1" }, "mongodb://127.0.0.1:27017/shop").defaultDatabase; // "shop"
 */
export function resolveSettings(environment, connectionUrl) {
  if (!CONNECTION_SCHEMES.test(connectionUrl)) {
    throw invalidInput("The connection string must start with mongodb:// or mongodb+srv://");
  }
  return {
    connectionUrl,
    defaultDatabase: readText(environment?.MONGODB_DATABASE) ?? databaseFromUrl(connectionUrl),
    toolWritesAllowed: readText(environment?.MONGODB_TOOL_ALLOW_WRITES) === "1",
    toolAllowedDatabases: readAllowedDatabases(environment?.MONGODB_TOOL_ALLOWED_DATABASES),
    maxResultBytes: readPositiveInteger(environment?.MONGODB_MAX_RESULT_BYTES, "MONGODB_MAX_RESULT_BYTES", DEFAULT_MAX_RESULT_BYTES, MAX_RESULT_BYTES_LIMIT),
    idleTimeoutMs: readPositiveInteger(environment?.MONGODB_IDLE_MINUTES, "MONGODB_IDLE_MINUTES", DEFAULT_IDLE_MINUTES, 24 * 60) * 60_000,
  };
}

/**
 * Reads the default database from the path of a connection string.
 *
 * @param connectionUrl - e.g. "mongodb://host/shop?authSource=admin" (string)
 * @returns Database name, or null when the path is empty (string | null)
 */
export function databaseFromUrl(connectionUrl) {
  const match = /^[^:]+:\/\/[^/]*\/([^?#]*)/.exec(connectionUrl);
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Reads MONGODB_TOOL_ALLOWED_DATABASES: "*" (any non-internal database) or comma-separated names.
 *
 * @param rawValue - Variable value (string, optional)
 * @returns "*" or the names (string | string[])
 * @throws PluginError kind `invalid_input` - When a name is invalid
 */
export function readAllowedDatabases(rawValue) {
  const text = readText(rawValue);
  if (text === null) return [];
  if (text === "*") return "*";
  return text.split(",").map((name) => name.trim()).filter(Boolean)
    .map((name) => validateDatabaseName(name, `MONGODB_TOOL_ALLOWED_DATABASES entry \`${name}\``));
}

function readText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function readPositiveInteger(rawValue, variableName, defaultValue, maximum) {
  const text = readText(rawValue);
  if (text === null) return defaultValue;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw invalidInput(`${variableName} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}
