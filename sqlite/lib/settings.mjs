/**
 * Reads the sqlite plugin's environment: the directories database files may
 * live in, the default database, and the limits.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { invalidInput } from "./errors.mjs";
import { readInteger, readText } from "./environment-readers.mjs";

export const ALLOWED_DIRS_VARIABLE = "SQLITE_ALLOWED_DIRS";
export const DEFAULT_PATH_VARIABLE = "SQLITE_PATH";
export const TOOL_WRITES_VARIABLE = "SQLITE_TOOL_ALLOW_WRITES";
export const LIMIT_VARIABLES = ["SQLITE_STATEMENT_TIMEOUT_MS", "SQLITE_BUSY_TIMEOUT_MS", "SQLITE_MAX_RESULT_BYTES"];

/**
 * Builds settings from environment variables.
 *
 * @param environment - Environment variables (object)
 * @returns `{allowedDirectories, defaultDatabasePath, statementTimeoutMs, busyTimeoutMs, maxResultBytes}`; paths are absolute (object)
 * @throws PluginError kind `invalid_input` - When a variable has an invalid value
 */
export function resolveSettings(environment = {}) {
  const homeDirectory = environment.HOME || homedir();
  const defaultPathText = readText(environment, DEFAULT_PATH_VARIABLE);
  return {
    allowedDirectories: readDirectoryList(readText(environment, ALLOWED_DIRS_VARIABLE), homeDirectory),
    defaultDatabasePath: defaultPathText ? expandHome(defaultPathText, homeDirectory, DEFAULT_PATH_VARIABLE) : null,
    homeDirectory,
    statementTimeoutMs: readInteger(environment, "SQLITE_STATEMENT_TIMEOUT_MS", 30000, { minimum: 100, maximum: 600000 }),
    busyTimeoutMs: readInteger(environment, "SQLITE_BUSY_TIMEOUT_MS", 5000, { minimum: 0, maximum: 60000 }),
    maxResultBytes: readInteger(environment, "SQLITE_MAX_RESULT_BYTES", 1000000, { minimum: 1000, maximum: 8000000 }),
  };
}

/**
 * Expands `~/` and checks that a path is absolute.
 *
 * @param configuredPath - Path from the environment or an argument (string)
 * @param homeDirectory - Home directory for `~` (string)
 * @param sourceName - Variable or parameter name for the message (string)
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

function readDirectoryList(listText, homeDirectory) {
  if (!listText) return [];
  return listText
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => expandHome(entry, homeDirectory, ALLOWED_DIRS_VARIABLE));
}
