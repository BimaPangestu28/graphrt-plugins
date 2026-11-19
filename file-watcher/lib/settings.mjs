/**
 * Reads the file-watcher plugin's environment: the allowed directories and the snapshot size cap.
 */
import { homedir } from "node:os";
import { expandHome, readInteger, readText } from "./environment-readers.mjs";

export const ALLOWED_DIRS_VARIABLE = "FILE_WATCHER_ALLOWED_DIRS";
export const MAX_ENTRIES_VARIABLE = "FILE_WATCHER_MAX_ENTRIES";

/**
 * Builds settings from environment variables.
 *
 * @param environment - Environment variables (object)
 * @returns `{allowedDirectories, maxEntries}` (object)
 * @throws PluginError kind `invalid_input` - When a variable is invalid
 */
export function readFileWatcherSettings(environment = {}) {
  const homeDirectory = environment?.HOME || homedir();
  return {
    allowedDirectories: (readText(environment, ALLOWED_DIRS_VARIABLE) ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => expandHome(entry, homeDirectory, ALLOWED_DIRS_VARIABLE)),
    maxEntries: readInteger(environment, MAX_ENTRIES_VARIABLE, 10000, { minimum: 10, maximum: 100000 }),
    homeDirectory,
  };
}
