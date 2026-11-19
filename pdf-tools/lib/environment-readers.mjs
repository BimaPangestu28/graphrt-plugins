/**
 * Small validated readers for environment variables and configured paths.
 * This file is identical in the ffmpeg, image-tools, pdf-tools, excel-csv,
 * ocr-tesseract and qr-code plugins; keep the copies in step.
 */
import { isAbsolute, join, resolve } from "node:path";
import { invalidInput } from "./errors.mjs";

/**
 * Reads a trimmed text variable.
 *
 * @param environment - Environment variables (object)
 * @param variableName - Variable to read (string)
 * @returns The trimmed value, or null when unset or blank (string | null)
 * @throws PluginError kind `invalid_input` - When the value contains a line break or NUL
 */
export function readText(environment, variableName) {
  const rawValue = environment?.[variableName];
  const trimmed = typeof rawValue === "string" ? rawValue.trim() : "";
  if (/[\r\n\0]/.test(trimmed)) throw invalidInput(`${variableName} must not contain line breaks or NUL characters`);
  return trimmed || null;
}

/**
 * Reads an integer variable within bounds.
 *
 * @param environment - Environment variables (object)
 * @param variableName - Variable to read (string)
 * @param defaultValue - Value when unset (number)
 * @param bounds - `{minimum, maximum}` (object)
 * @returns The integer (number)
 * @throws PluginError kind `invalid_input` - When the value is not an integer within bounds
 */
export function readInteger(environment, variableName, defaultValue, { minimum, maximum }) {
  const rawValue = readText(environment, variableName);
  if (rawValue === null) return defaultValue;
  const numericValue = Number(rawValue);
  if (!Number.isInteger(numericValue) || numericValue < minimum || numericValue > maximum) {
    throw invalidInput(`${variableName} must be an integer from ${minimum} to ${maximum}, got ${JSON.stringify(rawValue)}`);
  }
  return numericValue;
}

/**
 * Reads an opt-in flag: only the exact value "1" turns it on.
 *
 * @param environment - Environment variables (object)
 * @param variableName - Variable to read (string)
 * @returns True when the variable is "1" (boolean)
 */
export function readOptInFlag(environment, variableName) {
  return readText(environment, variableName) === "1";
}

/**
 * Expands `~/` and checks that a configured path is absolute.
 *
 * @param configuredPath - Path from the environment (string)
 * @param homeDirectory - Home directory for `~` (string)
 * @param sourceName - Variable name for the message (string)
 * @returns Absolute, normalised path (string)
 * @throws PluginError kind `invalid_input` - When the path is relative or contains NUL
 */
export function expandHome(configuredPath, homeDirectory, sourceName) {
  if (configuredPath.includes("\0")) throw invalidInput(`${sourceName} must not contain NUL characters`);
  if (configuredPath === "~") return homeDirectory;
  if (configuredPath.startsWith("~/")) return join(homeDirectory, configuredPath.slice(2));
  if (!isAbsolute(configuredPath)) throw invalidInput(`${sourceName}: path ${JSON.stringify(configuredPath)} must be absolute or start with ~/`);
  return resolve(configuredPath);
}

/**
 * Reads an executable path override (e.g. FFMPEG_PATH): absolute, or the bare default name looked up on PATH.
 *
 * @param environment - Environment variables (object)
 * @param variableName - Override variable (string)
 * @param defaultName - Program name to look up on PATH when unset, e.g. "ffmpeg" (string)
 * @returns Absolute path or the bare default name (string)
 * @throws PluginError kind `invalid_input` - When the override is not an absolute path
 */
export function readExecutable(environment, variableName, defaultName) {
  const configuredPath = readText(environment, variableName);
  if (configuredPath === null) return defaultName;
  if (!isAbsolute(configuredPath)) throw invalidInput(`${variableName} must be an absolute path to the ${defaultName} executable`);
  return resolve(configuredPath);
}
