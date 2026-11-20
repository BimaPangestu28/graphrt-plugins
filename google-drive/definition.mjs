/**
 * google-drive plugin definition: the Google Drive API v3 (https://developers.google.com/workspace/drive/api/reference/rest/v3).
 * List and search files, metadata, export Google files and download content to a directory, upload, folders,
 * copy, rename/move, permissions and shared drives. Built with the declarative REST layer
 * (docs/declarative-plugins.md); Google credentials come from the shared Google auth files (lib/google-rest-auth.mjs);
 * `search_files` builds an escaped query (lib/drive-query.mjs) and `upload_file` is hand-written (lib/upload-file.mjs).
 *
 * Agent policy: sharing (permission changes), trashing and deleting are node only; tool calls that put a file into a
 * folder need that folder in GOOGLE_DRIVE_TOOL_FOLDER_ALLOWLIST (lib/folder-policy.mjs).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { wrapSearchFiles } from "./lib/drive-query.mjs";
import { createGoogleAuth, createGoogleErrors, GOOGLE_AUTH_ENV, withGoogleCredentials } from "./lib/google-rest-auth.mjs";
import { FOLDER_ALLOWLIST_ENV, guardToolFolders } from "./lib/folder-policy.mjs";
import { UPLOAD_DIR_ENV, uploadFileOperation } from "./lib/upload-file.mjs";

const DOWNLOAD_DIR_ENV = "GOOGLE_DRIVE_DOWNLOAD_DIR";
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,createdTime,parents,owners(emailAddress),webViewLink,trashed";
const FILE_ID = { in: "path", type: "string", required: true, description: "File or folder id (from its URL)" };
const ALL_DRIVES = { supportsAllDrives: true };
const fieldsParam = (defaultFields) => ({ in: "query", type: "string", default: defaultFields, description: "Fields to return (Drive partial response syntax)" });
const listParams = {
  order_by: { in: "query", type: "string", wireName: "orderBy", description: "e.g. modifiedTime desc, name, folder,name" },
  corpora: { in: "query", type: "string", enum: ["user", "drive", "domain", "allDrives"], description: "Which files to search (default user)" },
  drive_id: { in: "query", type: "string", wireName: "driveId", description: "Shared drive id (with corpora drive)" },
  include_items_from_all_drives: { in: "query", type: "boolean", default: true, wireName: "includeItemsFromAllDrives" },
  fields: fieldsParam(`nextPageToken,files(${FILE_FIELDS})`),
};
const filePage = { dataPath: "files", cursorPath: "nextPageToken", cursorParam: "pageToken", limitParam: "pageSize", maxLimit: 1000, defaultLimit: 50 };

const readOperations = [
  { name: "get_about", title: "Account and quota", description: "The signed-in user and storage quota", path: "/about", params: { fields: fieldsParam("user(displayName,emailAddress),storageQuota") } },
  {
    name: "list_files",
    title: "List files",
    description: "Files matching a raw Drive query (q), e.g. \"'<folder id>' in parents and trashed = false\"",
    path: "/files",
    params: { q: { in: "query", type: "string", description: "Drive query; see search_files for plain fields" }, ...listParams },
    constants: { query: ALL_DRIVES },
    response: filePage,
  },
  {
    name: "search_files",
    title: "Search files",
    description: "Find files by name words, content words, type, folder or modification date (not trashed by default)",
    path: "/files",
    // lib/drive-query.mjs replaces `q` with plain fields and escapes them.
    params: { q: { in: "query", type: "string" }, ...listParams },
    constants: { query: ALL_DRIVES },
    response: filePage,
  },
  { name: "get_file", title: "Get file", description: "Metadata of a file or folder", path: "/files/{file_id}", params: { file_id: FILE_ID, fields: fieldsParam(`${FILE_FIELDS},description,exportLinks`) }, constants: { query: ALL_DRIVES } },
  {
    name: "export_file",
    title: "Export Google file",
    description: `Export a Google Docs/Sheets/Slides/Drawings file (e.g. to PDF, DOCX, CSV) into $${DOWNLOAD_DIR_ENV} (Drive allows up to 10 MB)`,
    path: "/files/{file_id}/export",
    params: {
      file_id: FILE_ID,
      mime_type: { in: "query", type: "string", required: true, wireName: "mimeType", description: "e.g. application/pdf, text/plain, text/csv, application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    },
    timeoutMs: 300000,
    response: { binary: { envDir: DOWNLOAD_DIR_ENV, maxBytes: 10 * 1024 * 1024 } },
  },
  {
    name: "download_file",
    title: "Download file",
    description: `Download a stored (non-Google) file's content into $${DOWNLOAD_DIR_ENV}; use export_file for Google Docs/Sheets/Slides`,
    path: "/files/{file_id}",
    params: { file_id: FILE_ID },
    constants: { query: { alt: "media", ...ALL_DRIVES } },
    timeoutMs: 300000,
    response: { binary: { envDir: DOWNLOAD_DIR_ENV, maxBytes: 200 * 1024 * 1024 } },
  },
  { name: "list_permissions", title: "List sharing", description: "Who a file or folder is shared with", path: "/files/{file_id}/permissions", params: { file_id: FILE_ID, fields: fieldsParam("permissions(id,type,role,emailAddress,domain,displayName,expirationTime)") }, constants: { query: ALL_DRIVES } },
  { name: "list_drives", title: "Shared drives", description: "Shared drives the user can see", path: "/drives", params: { q: { in: "query", type: "string", description: "e.g. name contains 'Finance'" } }, response: { dataPath: "drives", cursorPath: "nextPageToken", cursorParam: "pageToken", limitParam: "pageSize", maxLimit: 100, defaultLimit: 50 } },
];

const writeOperations = [
  {
    name: "create_folder",
    title: "Create folder",
    description: "Create a folder (in My Drive's root unless a parent is given)",
    method: "POST",
    path: "/files",
    write: "unsafe",
    checkHint: "search_files with the name and mime_type application/vnd.google-apps.folder",
    params: { name: { in: "body", type: "string", required: true, minLength: 1 }, parent_ids: { in: "body", type: "array", items: { type: "string" }, maxItems: 1, wireName: "parents", description: "Parent folder id, as a one-item list" }, fields: fieldsParam("id,name,webViewLink") },
    constants: { query: ALL_DRIVES, body: { mimeType: "application/vnd.google-apps.folder" } },
  },
  {
    name: "copy_file",
    title: "Copy file",
    description: "Copy a file (e.g. a template) with a new name and folder",
    method: "POST",
    path: "/files/{file_id}/copy",
    write: "unsafe",
    checkHint: "search_files with the new name",
    params: { file_id: FILE_ID, name: { in: "body", type: "string" }, parent_ids: { in: "body", type: "array", items: { type: "string" }, maxItems: 1, wireName: "parents", description: "Folder for the copy, as a one-item list" }, fields: fieldsParam("id,name,webViewLink") },
    constants: { query: ALL_DRIVES },
  },
  {
    name: "update_file",
    title: "Rename or move",
    description: "Rename a file, change its description or star, or move it between folders",
    method: "PATCH",
    path: "/files/{file_id}",
    write: "idempotent",
    params: {
      file_id: FILE_ID,
      name: { in: "body", type: "string" },
      description: { in: "body", type: "string" },
      starred: { in: "body", type: "boolean" },
      add_parents: { in: "query", type: "string", wireName: "addParents", description: "Folder id to move into" },
      remove_parents: { in: "query", type: "string", wireName: "removeParents", description: "Folder id to move out of" },
      fields: fieldsParam("id,name,parents,webViewLink"),
    },
    constants: { query: ALL_DRIVES },
  },
  {
    name: "share_file",
    title: "Share file",
    description: "Give a user, group, domain or anyone access to a file or folder",
    method: "POST",
    path: "/files/{file_id}/permissions",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_permissions for the file",
    params: {
      file_id: FILE_ID,
      role: { in: "body", type: "string", required: true, enum: ["reader", "commenter", "writer", "fileOrganizer", "organizer"] },
      grantee_type: { in: "body", type: "string", required: true, enum: ["user", "group", "domain", "anyone"], wireName: "type", description: "Who gets access (sent as `type`)" },
      email_address: { in: "body", type: "string", wireName: "emailAddress", description: "For user and group" },
      domain: { in: "body", type: "string", description: "For domain" },
      send_notification_email: { in: "query", type: "boolean", wireName: "sendNotificationEmail" },
      email_message: { in: "query", type: "string", wireName: "emailMessage" },
    },
    constants: { query: ALL_DRIVES },
  },
  { name: "remove_permission", title: "Unshare", description: "Remove one permission from a file or folder", method: "DELETE", path: "/files/{file_id}/permissions/{permission_id}", write: "idempotent", nodeOnly: true, params: { file_id: FILE_ID, permission_id: { in: "path", type: "string", required: true } }, constants: { query: ALL_DRIVES } },
  { name: "trash_file", title: "Trash file", description: "Move a file or folder to the trash (restorable for 30 days)", method: "PATCH", path: "/files/{file_id}", write: "idempotent", nodeOnly: true, params: { file_id: FILE_ID }, constants: { query: ALL_DRIVES, body: { trashed: true } } },
  { name: "delete_file", title: "Delete file", description: "Delete a file permanently, skipping the trash", method: "DELETE", path: "/files/{file_id}", write: "idempotent", nodeOnly: true, params: { file_id: FILE_ID }, constants: { query: ALL_DRIVES } },
];

const restDefinition = defineRestPlugin({
  name: "google-drive",
  version: "0.1.0",
  description: "Google Drive: list and search files, export and download to a directory, upload, folders, copy, rename/move, sharing (node only) and shared drives (OAuth or service account)",
  apiName: "Google Drive API",
  baseUrl: "https://www.googleapis.com/drive/v3",
  toolUserToken: { credentialEnv: GOOGLE_AUTH_ENV },
  auth: createGoogleAuth("https://www.googleapis.com/auth/drive"),
  extraEnv: [UPLOAD_DIR_ENV, FOLDER_ALLOWLIST_ENV],
  limits: { timeout_ms: 360000 },
  errors: createGoogleErrors("error.errors.0.reason"),
  apiRequest: { examplePath: "/files?q=starred%20%3D%20true" },
  operations: [...readOperations, ...writeOperations],
});

const googleDefinition = withGoogleCredentials(restDefinition);
const wrappers = {
  search_files: wrapSearchFiles,
  copy_file: (operation) => guardToolFolders(operation, (args) => args.parent_ids),
  create_folder: (operation) => guardToolFolders(operation, (args) => args.parent_ids),
  update_file: (operation) => guardToolFolders(operation, (args) => [args.add_parents]),
};
const operationsWithSearch = googleDefinition.operations.map((operation) => wrappers[operation.name]?.(operation) ?? operation);
const apiRequestIndex = operationsWithSearch.findIndex((operation) => operation.name === "api_request");
export const pluginDefinition = { ...googleDefinition, operations: [...operationsWithSearch.slice(0, apiRequestIndex), guardToolFolders(uploadFileOperation, (args) => [args.folder_id]), ...operationsWithSearch.slice(apiRequestIndex)] };
