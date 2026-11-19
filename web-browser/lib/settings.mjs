/**
 * Reads the plugin's environment variables into validated settings.
 *
 * There is deliberately no setting that allows internal hosts: the public-host
 * policy can only be relaxed by injecting `allowedTestHosts` in tests.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { invalidInput } from "./errors.mjs";
import { resolveLiveViewDirectory } from "./live-view.mjs";

export const DEFAULT_IDLE_MINUTES = 5;
export const DEFAULT_MAX_PAGES = 2;
export const DEFAULT_MAX_DOWNLOAD_MB = 15;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * Builds settings from environment variables, applying defaults.
 *
 * @param environment - Environment variables (object)
 * @returns `{screenshotDirectory, respectRobots, idleTimeoutMs, maxConcurrentPages, maxDownloadBytes, userAgentOverride,
 *   liveViewDirectory}`; `liveViewDirectory` is set by a host that shows pages live (GRAPHRT_LIVE_VIEW_DIR), else null (object)
 * @throws PluginError kind `invalid_input` - When a variable has an invalid value
 */
export function resolveSettings(environment = {}) {
  const homeDirectory = environment.HOME || homedir();
  return {
    screenshotDirectory: resolveScreenshotDirectory(environment.WEB_BROWSER_SCREENSHOT_DIR, homeDirectory),
    respectRobots: readBoolean(environment, "WEB_BROWSER_RESPECT_ROBOTS", true),
    idleTimeoutMs: readNumber(environment, "WEB_BROWSER_IDLE_MINUTES", DEFAULT_IDLE_MINUTES, { minimum: 0.1, maximum: 1440 }) * 60000,
    maxConcurrentPages: readNumber(environment, "WEB_BROWSER_MAX_PAGES", DEFAULT_MAX_PAGES, { minimum: 1, maximum: 4, integer: true }),
    maxDownloadBytes: readNumber(environment, "WEB_BROWSER_MAX_DOWNLOAD_MB", DEFAULT_MAX_DOWNLOAD_MB, { minimum: 1, maximum: 100 }) * 1024 * 1024,
    userAgentOverride: readUserAgent(environment.WEB_BROWSER_USER_AGENT),
    liveViewDirectory: resolveLiveViewDirectory(environment),
  };
}

function resolveScreenshotDirectory(configuredPath, homeDirectory) {
  const trimmedPath = configuredPath?.trim();
  if (!trimmedPath) return join(homeDirectory, ".graphrt", "web-browser", "screenshots");
  if (trimmedPath === "~") return homeDirectory;
  if (trimmedPath.startsWith("~/")) return join(homeDirectory, trimmedPath.slice(2));
  if (!isAbsolute(trimmedPath)) throw invalidInput(`WEB_BROWSER_SCREENSHOT_DIR must be absolute or start with ~/, got ${JSON.stringify(trimmedPath)}`);
  return resolve(trimmedPath);
}

function readBoolean(environment, variableName, defaultValue) {
  const rawValue = String(environment[variableName] ?? "").trim().toLowerCase();
  if (!rawValue) return defaultValue;
  if (TRUE_VALUES.has(rawValue)) return true;
  if (FALSE_VALUES.has(rawValue)) return false;
  throw invalidInput(`${variableName} must be 1 or 0, got ${JSON.stringify(environment[variableName])}`);
}

function readNumber(environment, variableName, defaultValue, { minimum, maximum, integer = false }) {
  const rawValue = environment[variableName];
  if (rawValue === undefined || String(rawValue).trim() === "") return defaultValue;
  const numericValue = Number(rawValue);
  const isValid = Number.isFinite(numericValue) && numericValue >= minimum && numericValue <= maximum && (!integer || Number.isInteger(numericValue));
  if (!isValid) {
    throw invalidInput(`${variableName} must be ${integer ? "an integer" : "a number"} from ${minimum} to ${maximum}, got ${JSON.stringify(rawValue)}`);
  }
  return numericValue;
}

function readUserAgent(rawValue) {
  const trimmedValue = rawValue?.trim();
  if (!trimmedValue) return null;
  if (trimmedValue.length > 300 || /[\r\n\u0000-\u001f]/.test(trimmedValue)) throw invalidInput("WEB_BROWSER_USER_AGENT must be one line of at most 300 characters");
  return trimmedValue;
}
