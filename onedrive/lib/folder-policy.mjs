/**
 * Folder allowlist for agent tools. Folders other people shared with the user can sit in the user's own drive
 * (shortcuts in "My files"), so an agent that can upload, create, move or copy into any folder could put private
 * files where others can read them (exfiltration). Tool calls that name a parent folder (`upload_file`,
 * `create_folder`, `update_item` and `copy_item` parent_id) need it to be `root` or listed in
 * ONEDRIVE_TOOL_FOLDER_ALLOWLIST (comma-separated item ids, or `*` for any folder). Workflow nodes are not limited.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const FOLDER_ALLOWLIST_ENV = "ONEDRIVE_TOOL_FOLDER_ALLOWLIST";
const ROOT_FOLDER = "root";

/**
 * Parses the allowlist env value.
 *
 * @param allowlistText - e.g. "01ABC, 01DEF" or "*" (string, optional)
 * @returns Folder ids; ["*"] allows any (string[])
 */
export function parseFolderAllowlist(allowlistText) {
  return String(allowlistText ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Refuses a tool call that puts an item into a folder outside the allowlist.
 *
 * @param context - Operation context `{source, environment}` (object)
 * @param folderId - Parent folder id the call sets (string, optional; undefined means no parent change)
 * @returns Nothing
 * @throws PluginError kind `permission_denied` - The folder is not root and not allowed
 */
export function assertToolFolderAllowed({ source, environment }, folderId) {
  if (source !== "tool" || folderId === undefined || folderId === ROOT_FOLDER) return;
  const allowedIds = parseFolderAllowlist(environment?.[FOLDER_ALLOWLIST_ENV]);
  if (allowedIds.includes("*") || allowedIds.includes(folderId)) return;
  throw new PluginError(`Agent tools may only put items into root or folders listed in ${FOLDER_ALLOWLIST_ENV} (or "*"); not allowed: ${folderId}. Use a workflow node for other folders`, { kind: "permission_denied" });
}

/**
 * Wraps an operation so its run checks `args.parent_id` first.
 *
 * @param operation - Operation with a `parent_id` param (object)
 * @returns Operation with a guarded run (object)
 */
export function guardToolFolder(operation) {
  return {
    ...operation,
    run: (context) => {
      assertToolFolderAllowed(context, context.args.parent_id);
      assertToolNamesArePlain(context, [context.args.file_name, context.args.name]);
      assertToolStaysInOwnDrive(context, context.args.parent_drive_id);
      return operation.run(context);
    },
  };
}

/**
 * Refuses tool names that are paths: Graph resolves `items/root:/Shared/leak.txt:/content` by path, so a name with
 * `/` (or `\`, or `:` which ends the path segment) would land outside the checked parent folder.
 *
 * @param context - Operation context `{source}` (object)
 * @param names - File or item names of the call (string[]; undefined entries are ignored)
 * @returns Nothing
 * @throws PluginError kind `permission_denied` - A name contains `/`, `\` or `:`
 */
export function assertToolNamesArePlain({ source }, names) {
  if (source !== "tool") return;
  const pathLikeName = names.find((itemName) => typeof itemName === "string" && /[/\\:]/.test(itemName));
  if (pathLikeName === undefined) return;
  throw new PluginError(`Agent tools may not use "/", "\\" or ":" in a file or folder name (got ${JSON.stringify(pathLikeName)}); put the item into its folder with parent_id`, { kind: "permission_denied" });
}

/**
 * Refuses a tool copy into another drive: the folder allowlist only names folders of the user's own drive.
 *
 * @param context - Operation context `{source}` (object)
 * @param driveId - `parent_drive_id` of the call (string, optional)
 * @returns Nothing
 * @throws PluginError kind `permission_denied` - A drive id is given in a tool call
 */
export function assertToolStaysInOwnDrive({ source }, driveId) {
  if (source !== "tool" || driveId === undefined) return;
  throw new PluginError("Agent tools may not copy into another drive (parent_drive_id); use a workflow node", { kind: "permission_denied" });
}
