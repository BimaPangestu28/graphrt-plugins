/**
 * Destination allowlist for agent tools. Shared folders are mounted into the user's own Dropbox paths, so an agent
 * that can upload, move or copy anywhere could put private files into a folder other people can read
 * (exfiltration). Tool calls that write to a destination path (`upload_file` path, `move`/`copy` to_path) need it
 * inside a prefix listed in DROPBOX_TOOL_PATH_ALLOWLIST (comma-separated paths such as `/Agent,/Inbox`, or `*`
 * for any path). Unset means tools may not write to any destination. Workflow nodes are not limited.
 *
 * Paths are compared case-insensitively (Dropbox paths are), with repeated and trailing slashes removed. Paths
 * with `.` or `..` segments, relative paths and the `id:`, `ns:` and `rev:` forms are refused for tools, because
 * where they point cannot be checked before the call.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const PATH_ALLOWLIST_ENV = "DROPBOX_TOOL_PATH_ALLOWLIST";
const ANY_PATH = "*";

/**
 * Normalizes an absolute Dropbox path for comparison.
 *
 * @param dropboxPath - e.g. "/Team//Reports/" (string)
 * @returns Lowercased path without repeated or trailing slashes ("/" for the root), or null when the path is
 *   relative, uses `.`/`..` segments, or is an id:/ns:/rev: reference (string | null)
 *
 * @example
 * normalizeDropboxPath("/Team//Reports/"); // "/team/reports"
 */
export function normalizeDropboxPath(dropboxPath) {
  if (typeof dropboxPath !== "string" || !dropboxPath.startsWith("/")) return null;
  const segments = dropboxPath.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return `/${segments.join("/")}`.toLowerCase();
}

/**
 * Parses DROPBOX_TOOL_PATH_ALLOWLIST.
 *
 * @param allowlistText - e.g. "/Agent, /Inbox" or "*" (string, optional)
 * @returns Normalized prefixes, or ["*"] for any path (string[])
 */
export function parsePathAllowlist(allowlistText) {
  const entries = String(allowlistText ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.includes(ANY_PATH)) return [ANY_PATH];
  return entries.map(normalizeDropboxPath).filter(Boolean);
}

function isInsidePrefix(normalizedPath, prefix) {
  if (prefix === "/") return true;
  return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
}

/**
 * Refuses a tool call whose destination paths are outside the allowlist.
 *
 * @param context - Operation context `{source, environment}` (object)
 * @param destinationPaths - Destination paths of the call (string[])
 * @returns Nothing
 * @throws PluginError kind `permission_denied` - A path is not allowed, or the allowlist is unset
 */
export function assertToolPathsAllowed({ source, environment }, destinationPaths) {
  if (source !== "tool") return;
  const allowedPrefixes = parsePathAllowlist(environment?.[PATH_ALLOWLIST_ENV]);
  if (allowedPrefixes.includes(ANY_PATH)) return;
  const refusedPaths = destinationPaths.filter((destinationPath) => {
    const normalizedPath = normalizeDropboxPath(destinationPath);
    return !normalizedPath || !allowedPrefixes.some((prefix) => isInsidePrefix(normalizedPath, prefix));
  });
  if (refusedPaths.length === 0) return;
  throw new PluginError(`Agent tools may only write into paths under ${PATH_ALLOWLIST_ENV} (comma-separated prefixes such as /Agent, or "*"); not allowed: ${refusedPaths.join(", ")}. Use a workflow node for other destinations`, { kind: "permission_denied" });
}

/**
 * Wraps an operation so its run checks the destination paths named by `readPaths(args)` first.
 *
 * @param operation - Operation (object)
 * @param readPaths - `(args) => string[]` (function)
 * @returns Operation with a guarded run (object)
 */
export function guardToolPaths(operation, readPaths) {
  return {
    ...operation,
    run: (context) => {
      assertToolPathsAllowed(context, readPaths(context.args));
      return operation.run(context);
    },
  };
}
