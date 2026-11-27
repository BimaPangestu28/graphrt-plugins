/**
 * file-watcher plugin definition: notice new, changed and removed files in
 * allowed directories by polling. graphrt calls are request/response, so
 * there is no background watcher: `snapshot` returns a cursor,
 * `list_changes` diffs against it, and `wait_for_change` polls until a change
 * or a timeout. Read-only, no network (`localOnly`).
 */
import { isAbsolute, resolve } from "node:path";
import { promises as defaultFileSystem } from "node:fs";
import { expandHome } from "./lib/environment-readers.mjs";
import { sleepUnlessCancelled } from "./lib/shared/sleep.mjs";
import { ALLOWED_DIRS_VARIABLE, MAX_ENTRIES_VARIABLE, readFileWatcherSettings } from "./lib/settings.mjs";
import { MAX_WAIT_SECONDS, watchOperations } from "./operations/watch.mjs";

// The longest wait plus a rescan, plus the tool deadline margin (10 s) the shared runner subtracts.
const CALL_TIMEOUT_MS = (MAX_WAIT_SECONDS + 30) * 1000;

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{fileSystem, now, sleep}` overrides (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  return {
    name: "file-watcher",
    version: "0.1.1",
    description: "Notice added, modified and removed files in allowed directories by polling: snapshot to a cursor, list changes since a cursor, or wait (up to 5 minutes) for the next change; bounded, never follows symlinks",
    extraEnv: [ALLOWED_DIRS_VARIABLE, MAX_ENTRIES_VARIABLE],
    localOnly: true,
    noCredentials: true,
    limits: { timeout_ms: CALL_TIMEOUT_MS, max_concurrency: 4 },
    createClient: ({ environment }) => {
      const settings = readFileWatcherSettings(environment);
      return {
        settings,
        fileSystem: dependencies.fileSystem ?? defaultFileSystem,
        now: dependencies.now ?? Date.now,
        sleep: dependencies.sleep ?? ((milliseconds, signal) => sleepUnlessCancelled(milliseconds, signal, "Waiting for a change was cancelled")),
        resolvePath: (baseDirectory, givenPath) => resolveGivenPath(baseDirectory, givenPath, settings.homeDirectory),
      };
    },
    operations: watchOperations,
  };
}

function resolveGivenPath(baseDirectory, givenPath, homeDirectory) {
  const trimmed = givenPath.trim() || ".";
  if (trimmed === "~" || trimmed.startsWith("~/")) return expandHome(trimmed, homeDirectory, "`path`");
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(baseDirectory, trimmed);
}

export const pluginDefinition = createPluginDefinition();
