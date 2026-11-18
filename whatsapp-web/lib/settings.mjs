/**
 * Reads the plugin's environment variables into validated settings.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { invalidInput } from "./errors.mjs";

export const DEFAULT_IDLE_MINUTES = 15;
export const DEFAULT_MIN_SEND_INTERVAL_SECONDS = 5;
export const DEFAULT_DAILY_SEND_LIMIT = 50;

/**
 * Builds settings from environment variables, applying defaults.
 *
 * @param environment - Environment variables (object)
 * @returns `{profileDirectory, idleTimeoutMs, minSendIntervalMs, dailySendLimit, allowedFileDirectories}` (object)
 * @throws PluginError kind `invalid_input` - When a variable has an invalid value
 */
export function resolveSettings(environment = {}) {
  const homeDirectory = environment.HOME || homedir();
  return {
    profileDirectory: resolveProfileDirectory(environment.WHATSAPP_WEB_PROFILE_DIR, homeDirectory),
    idleTimeoutMs: readNumber(environment, "WHATSAPP_WEB_IDLE_MINUTES", DEFAULT_IDLE_MINUTES, { minimum: 0.1 }) * 60000,
    minSendIntervalMs: readNumber(environment, "WHATSAPP_WEB_MIN_SEND_INTERVAL_SECONDS", DEFAULT_MIN_SEND_INTERVAL_SECONDS, { minimum: 0 }) * 1000,
    dailySendLimit: readNumber(environment, "WHATSAPP_WEB_DAILY_SEND_LIMIT", DEFAULT_DAILY_SEND_LIMIT, { minimum: 0, integer: true }),
    allowedFileDirectories: readDirectoryList(environment.WHATSAPP_WEB_ALLOWED_FILE_DIRS, homeDirectory),
  };
}

function resolveProfileDirectory(configuredPath, homeDirectory) {
  if (!configuredPath?.trim()) return join(homeDirectory, ".graphrt", "whatsapp-web", "profile");
  return expandHome(configuredPath.trim(), homeDirectory);
}

function expandHome(configuredPath, homeDirectory) {
  if (configuredPath === "~") return homeDirectory;
  if (configuredPath.startsWith("~/")) return join(homeDirectory, configuredPath.slice(2));
  if (!isAbsolute(configuredPath)) throw invalidInput(`Path ${JSON.stringify(configuredPath)} must be absolute or start with ~/`);
  return resolve(configuredPath);
}

function readNumber(environment, variableName, defaultValue, { minimum, integer = false }) {
  const rawValue = environment[variableName];
  if (rawValue === undefined || String(rawValue).trim() === "") return defaultValue;
  const numericValue = Number(rawValue);
  const isValid = Number.isFinite(numericValue) && numericValue >= minimum && (!integer || Number.isInteger(numericValue));
  if (!isValid) {
    throw invalidInput(`${variableName} must be ${integer ? "an integer" : "a number"} >= ${minimum}, got ${JSON.stringify(rawValue)}`);
  }
  return numericValue;
}

function readDirectoryList(rawList, homeDirectory) {
  if (!rawList?.trim()) return [];
  return rawList
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => expandHome(entry, homeDirectory));
}
