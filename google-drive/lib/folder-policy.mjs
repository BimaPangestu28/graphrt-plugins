/**
 * Folder allowlist for agent tools. An agent that can put files into any folder could copy, upload or move the
 * user's files into a folder someone else shared with them (exfiltration). So tool calls that set a parent folder
 * (`upload_file` folder_id, `copy_file`/`create_folder` parent_ids, `update_file` add_parents) need every such
 * folder id in GOOGLE_DRIVE_TOOL_FOLDER_ALLOWLIST (comma-separated ids, or `*` for any folder). Without it, tools
 * can only use the default location (no parent) or keep a file's existing parents. Workflow nodes are not limited.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const FOLDER_ALLOWLIST_ENV = "GOOGLE_DRIVE_TOOL_FOLDER_ALLOWLIST";

/**
 * Parses the allowlist env value.
 *
 * @param allowlistText - e.g. "1AbC, 2DeF" or "*" (string, optional)
 * @returns Folder ids; `["*"]` allows any (string[])
 */
export function parseFolderAllowlist(allowlistText) {
  return String(allowlistText ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Refuses a tool call that places a file into a folder outside the allowlist.
 *
 * @param context - Operation context `{source, environment}` (object)
 * @param folderIds - Parent folder ids the call sets (string[]; empty or undefined entries are ignored)
 * @returns Nothing
 * @throws PluginError kind `permission_denied` - A folder is not allowed
 */
export function assertToolFoldersAllowed({ source, environment }, folderIds) {
  const requestedIds = (folderIds ?? []).filter(Boolean);
  if (source !== "tool" || requestedIds.length === 0) return;
  const allowedIds = parseFolderAllowlist(environment?.[FOLDER_ALLOWLIST_ENV]);
  if (allowedIds.includes("*")) return;
  const refusedIds = requestedIds.filter((folderId) => !allowedIds.includes(folderId));
  if (refusedIds.length === 0) return;
  throw new PluginError(`Agent tools may only put files into folders listed in ${FOLDER_ALLOWLIST_ENV} (or "*"); not allowed: ${refusedIds.join(", ")}. Omit the folder to use the default location, or use a workflow node`, { kind: "permission_denied" });
}

/**
 * Wraps an operation so its run checks the folders named by `readFolderIds(args)` first.
 *
 * @param operation - Operation (object)
 * @param readFolderIds - `(args) => string[]` (function)
 * @returns Operation with a guarded run (object)
 */
export function guardToolFolders(operation, readFolderIds) {
  return {
    ...operation,
    run: (context) => {
      assertToolFoldersAllowed(context, readFolderIds(context.args));
      return operation.run(context);
    },
  };
}
