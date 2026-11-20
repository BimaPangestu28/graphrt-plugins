/**
 * dropbox plugin definition: the Dropbox API v2 (https://www.dropbox.com/developers/documentation/http/documentation)
 * as the signed-in user: account and space usage, list and search files, metadata, download into a directory,
 * upload up to 150 MB, folders, move and copy, and (node only) delete, shared links and temporary links.
 * Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Dropbox is RPC style: every endpoint is a POST. Read-only ones are `write: "idempotent"` so they are retried
 * like reads. Content endpoints live on content.dropboxapi.com and take their arguments in the JSON
 * `Dropbox-API-Arg` header (lib/dropbox-api-arg.mjs). Paged lists (`list_folder`, `search`) return Dropbox's own
 * `cursor`/`has_more`; the next page is a separate endpoint (`list_folder_continue`, `search_continue`).
 *
 * Agent policy: upload, move and copy destinations must be inside DROPBOX_TOOL_PATH_ALLOWLIST for tools
 * (lib/path-policy.mjs), and move/copy additionally need DROPBOX_TOOL_ALLOW_MOVE=1. Deletes, shared links (public
 * exposure) and temporary links (bearer download URLs) are node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { foldIntoApiArg } from "./lib/dropbox-api-arg.mjs";
import { guardToolPaths, PATH_ALLOWLIST_ENV } from "./lib/path-policy.mjs";

const CONTENT_BASE_URL = "https://content.dropboxapi.com/2";
const DOWNLOAD_DIR_ENV = "DROPBOX_DOWNLOAD_DIR";
const UPLOAD_DIR_ENV = "DROPBOX_UPLOAD_DIR";
const MOVE_POLICY = "optIn:DROPBOX_TOOL_ALLOW_MOVE";
const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 540000;
const pathParam = (description) => ({ in: "body", type: "string", required: true, minLength: 1, description });
const PATH_DESCRIPTION = 'Dropbox path such as "/Reports/q3.pdf", or "id:..." from metadata';
const cursorParam = { in: "body", type: "string", required: true, minLength: 1, description: "cursor from the previous response (when has_more is true)" };
const relocationParams = {
  from_path: pathParam("Path or id of the file or folder to move/copy"),
  to_path: pathParam('Destination path including the name, e.g. "/Archive/q3.pdf"'),
  autorename: { in: "body", type: "boolean", description: "Rename on conflict instead of failing (default false)" },
  allow_ownership_transfer: { in: "body", type: "boolean", description: "Allow moves that change the content's owner (default false)" },
};

const accountOperations = [
  { name: "get_current_account", title: "Current account", description: "The signed-in user's account: name, email, account type, root namespace", method: "POST", path: "/users/get_current_account", write: "idempotent" },
  { name: "get_space_usage", title: "Space usage", description: "Used and allocated storage in bytes", method: "POST", path: "/users/get_space_usage", write: "idempotent" },
];

const listOperations = [
  {
    name: "list_folder",
    title: "List folder",
    description: 'Entries of a folder ("" for the root); returns entries, cursor and has_more (continue with list_folder_continue)',
    method: "POST",
    path: "/files/list_folder",
    write: "idempotent",
    params: {
      path: { in: "body", type: "string", default: "", description: 'Folder path, "" for the root, or "id:..."' },
      recursive: { in: "body", type: "boolean", description: "Include every subfolder's contents (default false)" },
      include_deleted: { in: "body", type: "boolean", description: "Include deleted entries (default false)" },
      include_mounted_folders: { in: "body", type: "boolean", description: "Include shared and team folders (default true)" },
      page_size: { in: "body", type: "integer", min: 1, max: 2000, wireName: "limit", description: "Approximate maximum entries per page (Dropbox may return fewer)" },
    },
  },
  { name: "list_folder_continue", title: "List folder (next page)", description: "Next page of list_folder (or changes since an earlier cursor)", method: "POST", path: "/files/list_folder/continue", write: "idempotent", params: { cursor: cursorParam } },
  {
    name: "get_metadata",
    title: "Get metadata",
    description: "Metadata of a file or folder (.tag file|folder|deleted, id, path_display, size, server_modified, rev)",
    method: "POST",
    path: "/files/get_metadata",
    write: "idempotent",
    params: { path: pathParam(PATH_DESCRIPTION), include_deleted: { in: "body", type: "boolean" } },
  },
  {
    name: "search",
    title: "Search",
    description: "Search file and folder names (and content on paid plans); returns matches, cursor and has_more (continue with search_continue)",
    method: "POST",
    path: "/files/search_v2",
    write: "idempotent",
    params: {
      query: { in: "body", type: "string", required: true, minLength: 1, description: "Search text (max 1000 characters)" },
      folder_path: { in: "body", type: "string", wireName: "options.path", description: "Only search in this folder" },
      max_results: { in: "body", type: "integer", min: 1, max: 1000, wireName: "options.max_results", description: "Maximum matches (default 100)" },
      filename_only: { in: "body", type: "boolean", wireName: "options.filename_only", description: "Match names only, not content" },
      file_status: { in: "body", type: "string", enum: ["active", "deleted"], wireName: "options.file_status" },
      file_extensions: { in: "body", type: "array", items: { type: "string" }, wireName: "options.file_extensions", description: 'e.g. ["pdf", "docx"]' },
      file_categories: { in: "body", type: "array", items: { type: "string", enum: ["image", "document", "pdf", "spreadsheet", "presentation", "audio", "video", "folder", "paper", "others"] }, wireName: "options.file_categories" },
    },
  },
  { name: "search_continue", title: "Search (next page)", description: "Next page of search", method: "POST", path: "/files/search/continue_v2", write: "idempotent", params: { cursor: cursorParam } },
];

const contentOperations = [
  {
    name: "download_file",
    title: "Download file",
    description: `Download a file's content into $${DOWNLOAD_DIR_ENV} (up to 500 MB); returns {path, bytes, content_type}`,
    method: "POST",
    path: "/files/download",
    baseUrl: CONTENT_BASE_URL,
    write: "idempotent",
    timeoutMs: TRANSFER_TIMEOUT_MS,
    // lib/dropbox-api-arg.mjs turns `path` into the Dropbox-API-Arg JSON.
    params: { path: { in: "header", type: "string", required: true, minLength: 1, wireName: "Dropbox-API-Arg", description: PATH_DESCRIPTION } },
    response: { binary: { envDir: DOWNLOAD_DIR_ENV, maxBytes: MAX_DOWNLOAD_BYTES } },
  },
  {
    name: "upload_file",
    title: "Upload file",
    description: `Upload a file up to 150 MB (https URL, or an absolute path inside $${UPLOAD_DIR_ENV}) to a Dropbox path`,
    method: "POST",
    path: "/files/upload",
    baseUrl: CONTENT_BASE_URL,
    write: "unsafe",
    checkHint: "get_metadata for the destination path",
    bodyMode: "file",
    contentType: "application/octet-stream",
    fileBody: { fileDirEnv: UPLOAD_DIR_ENV, maxFileBytes: MAX_UPLOAD_BYTES },
    timeoutMs: TRANSFER_TIMEOUT_MS,
    minRequestMs: 240000,
    params: {
      file: { in: "body", type: "string", file: true, required: true },
      path: { in: "header", type: "string", required: true, minLength: 1, wireName: "Dropbox-API-Arg", description: 'Destination path including the name, e.g. "/Reports/q3.pdf"' },
      // Folded into the Dropbox-API-Arg header by lib/dropbox-api-arg.mjs; never sent as query params.
      mode: { in: "query", type: "string", enum: ["add", "overwrite"], description: "add (default: keep the existing file) or overwrite" },
      autorename: { in: "query", type: "boolean", description: "With mode add: rename instead of failing on a conflict" },
      mute: { in: "query", type: "boolean", description: "Do not notify the user's devices" },
      strict_conflict: { in: "query", type: "boolean", description: "Treat an identical existing file as a conflict too" },
    },
  },
];

const writeOperations = [
  {
    name: "create_folder",
    title: "Create folder",
    description: "Create a folder at a path",
    method: "POST",
    path: "/files/create_folder_v2",
    write: "unsafe",
    checkHint: "get_metadata for the path",
    params: { path: pathParam('Folder path, e.g. "/Reports/2026"'), autorename: { in: "body", type: "boolean", description: "Rename on conflict instead of failing" } },
  },
  { name: "move", title: "Move", description: "Move or rename a file or folder", method: "POST", path: "/files/move_v2", write: "unsafe", toolPolicy: MOVE_POLICY, checkHint: "get_metadata for from_path and to_path", params: relocationParams },
  { name: "copy", title: "Copy", description: "Copy a file or folder", method: "POST", path: "/files/copy_v2", write: "unsafe", toolPolicy: MOVE_POLICY, checkHint: "get_metadata for to_path", params: relocationParams },
  { name: "delete", title: "Delete", description: "Delete a file or folder (restorable from Dropbox's deleted files for a while)", method: "POST", path: "/files/delete_v2", write: "unsafe", nodeOnly: true, checkHint: "get_metadata for the path (include_deleted)", params: { path: pathParam(PATH_DESCRIPTION) } },
];

const linkOperations = [
  {
    name: "create_shared_link",
    title: "Create shared link",
    description: "Create a shared link to a file or folder (who can open it depends on settings and the account's defaults)",
    method: "POST",
    path: "/sharing/create_shared_link_with_settings",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_shared_links for the path",
    params: {
      path: pathParam(PATH_DESCRIPTION),
      audience: { in: "body", type: "string", enum: ["public", "team", "no_one"], wireName: "settings.audience" },
      access: { in: "body", type: "string", enum: ["viewer", "editor"], wireName: "settings.access" },
      expires: { in: "body", type: "string", wireName: "settings.expires", description: 'UTC time "2026-12-31T23:59:59Z" (paid plans)' },
      allow_download: { in: "body", type: "boolean", wireName: "settings.allow_download" },
    },
  },
  {
    name: "list_shared_links",
    title: "List shared links",
    description: "Shared links of a path, or all of the user's links without a path; returns links, cursor and has_more",
    method: "POST",
    path: "/sharing/list_shared_links",
    write: "idempotent",
    nodeOnly: true,
    params: { path: { in: "body", type: "string" }, cursor: { in: "body", type: "string" }, direct_only: { in: "body", type: "boolean" } },
  },
  { name: "get_temporary_link", title: "Temporary link", description: "A 4-hour direct download link to a file (anyone with it can download)", method: "POST", path: "/files/get_temporary_link", write: "idempotent", nodeOnly: true, params: { path: pathParam(PATH_DESCRIPTION) } },
];

const restDefinition = defineRestPlugin({
  name: "dropbox",
  version: "0.1.0",
  description: "Dropbox: list, search and read metadata, download to a directory, upload up to 150 MB, folders, move/copy (agents: opt-in and a path allowlist); deletes and links node only",
  apiName: "Dropbox API v2",
  baseUrl: "https://api.dropboxapi.com/2",
  toolUserToken: true,
  auth: {
    type: "oauth2",
    grant: "refresh_token",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    clientIdEnv: "DROPBOX_APP_KEY",
    clientSecretEnv: "DROPBOX_APP_SECRET",
    refreshTokenEnv: "DROPBOX_REFRESH_TOKEN",
  },
  extraEnv: [PATH_ALLOWLIST_ENV],
  limits: { timeout_ms: 600000 },
  // 409 is the endpoint-specific error: {"error_summary": "path/not_found/..", "error": {".tag": "path", ...}};
  // 401 {"error_summary": "expired_access_token/..", "error": {".tag": "expired_access_token"}}; 400 is plain text.
  errors: {
    messagePath: ["error_summary", "text"],
    codePath: "error.\\.tag",
    retryAfterPath: "error.retry_after",
    // auth_error codes last: an auth_error makes the OAuth client refresh once (see microsoft-graph/lib/graph-errors.mjs).
    kindByCode: { missing_scope: "permission_denied", user_suspended: "permission_denied", too_many_requests: "rate_limited", too_many_write_operations: "rate_limited", invalid_access_token: "auth_error", expired_access_token: "auth_error" },
  },
  apiRequest: { examplePath: "/files/list_folder" },
  operations: [...accountOperations, ...listOperations, ...contentOperations, ...writeOperations, ...linkOperations],
});

const wrappers = {
  download_file: (operation) => foldIntoApiArg(operation),
  upload_file: (operation) => guardToolPaths(foldIntoApiArg(operation, ["mode", "autorename", "mute", "strict_conflict"]), (args) => [args.path]),
  move: (operation) => guardToolPaths(operation, (args) => [args.to_path]),
  copy: (operation) => guardToolPaths(operation, (args) => [args.to_path]),
  // Every Dropbox endpoint is a POST and api_request is GET only for agent tools: in practice a node-only escape hatch.
  api_request: (operation) => ({ ...operation, description: `${operation.description} Every Dropbox endpoint is a POST (method "POST", JSON body), so this works from workflow nodes only.` }),
};

export const pluginDefinition = { ...restDefinition, operations: restDefinition.operations.map((operation) => wrappers[operation.name]?.(operation) ?? operation) };
