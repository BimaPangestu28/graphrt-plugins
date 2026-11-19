/**
 * Reads the image-tools environment: the file allowlist, the decoded-pixel
 * cap (against decompression bombs) and the per-call processing timeout.
 */
import { fileAccessVariableNames, readFileAccessSettings } from "./file-access.mjs";
import { readInteger } from "./environment-readers.mjs";

export const ENVIRONMENT_PREFIX = "IMAGE_TOOLS";
export const FILE_VARIABLES = fileAccessVariableNames(ENVIRONMENT_PREFIX);
export const MAX_PIXELS_VARIABLE = "IMAGE_TOOLS_MAX_INPUT_PIXELS";
export const TIMEOUT_VARIABLE = "IMAGE_TOOLS_TIMEOUT_SECONDS";
const MEBIBYTE = 1024 ** 2;

/**
 * Builds settings from environment variables.
 *
 * @param environment - Environment variables (object)
 * @returns `{files, maxInputPixels, timeoutSeconds}` (object)
 * @throws PluginError kind `invalid_input` - When a variable has an invalid value
 */
export function readImageSettings(environment = {}) {
  return {
    files: readFileAccessSettings(environment, {
      prefix: ENVIRONMENT_PREFIX,
      defaultMaxInputBytes: 100 * MEBIBYTE,
      defaultMaxOutputBytes: 100 * MEBIBYTE,
      maxBytesCeiling: 2048 * MEBIBYTE,
    }),
    maxInputPixels: readInteger(environment, MAX_PIXELS_VARIABLE, 100_000_000, { minimum: 1_000_000, maximum: 1_000_000_000 }),
    timeoutSeconds: readInteger(environment, TIMEOUT_VARIABLE, 60, { minimum: 1, maximum: 600 }),
  };
}
