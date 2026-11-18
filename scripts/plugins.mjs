/**
 * Shared helpers for repo scripts: find the plugins that are built from
 * `shared/` (they have a definition.mjs) and resolve paths.
 */
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SHARED_LIB_DIR = join(REPO_ROOT, "shared", "lib");

/**
 * Lists plugin directories that use the shared operation runner.
 *
 * @returns Absolute plugin directory paths (string[])
 */
export function findSharedPlugins() {
  return readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(REPO_ROOT, entry.name, "definition.mjs")))
    .map((entry) => join(REPO_ROOT, entry.name));
}
