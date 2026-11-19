/**
 * Reads the rss-reader plugin's environment: the feed size cap and the fetch timeout.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const MAX_FEED_BYTES_VARIABLE = "RSS_READER_MAX_FEED_BYTES";
export const TIMEOUT_VARIABLE = "RSS_READER_TIMEOUT_MS";
/** The manifest's per-call limit; a fetch's own timeout stays below it. */
export const CALL_TIMEOUT_MS = 60000;
const MEBIBYTE = 1024 * 1024;

/**
 * Builds settings from environment variables.
 *
 * @param environment - Environment variables (object)
 * @returns `{maxFeedBytes, timeoutMs}` (object)
 * @throws PluginError kind `invalid_input` - When a variable is not an integer within its bounds
 */
export function readRssReaderSettings(environment = {}) {
  return {
    maxFeedBytes: readInteger(environment, MAX_FEED_BYTES_VARIABLE, 5 * MEBIBYTE, { minimum: 65536, maximum: 50 * MEBIBYTE }),
    timeoutMs: readInteger(environment, TIMEOUT_VARIABLE, 20000, { minimum: 1000, maximum: CALL_TIMEOUT_MS - 15000 }),
  };
}

function readInteger(environment, variableName, defaultValue, { minimum, maximum }) {
  const rawValue = String(environment?.[variableName] ?? "").trim();
  if (rawValue === "") return defaultValue;
  const numericValue = Number(rawValue);
  if (!Number.isInteger(numericValue) || numericValue < minimum || numericValue > maximum) {
    throw new PluginError(`${variableName} must be an integer from ${minimum} to ${maximum}, got ${JSON.stringify(rawValue)}`, { kind: "invalid_input" });
  }
  return numericValue;
}
