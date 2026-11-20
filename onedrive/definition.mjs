/**
 * onedrive plugin definition: the signed-in user's OneDrive through Microsoft Graph v1.0
 * (https://learn.microsoft.com/en-us/graph/api/resources/onedrive): drive and items, children, paths, search,
 * download into a directory, upload up to 250 MB, folders, rename/move, copy, sharing (read; creating links and
 * invitations node only) and delete (node only). Built with the declarative REST layer
 * (docs/declarative-plugins.md); the tenant-dependent OAuth token URL and the Graph error mapping are copied from
 * the microsoft-graph plugin (lib/graph-tenant.mjs, lib/graph-errors.mjs), with the same MICROSOFT_* env vars.
 *
 * Agent policy: tool calls that put an item into a folder other than root need that folder in
 * ONEDRIVE_TOOL_FOLDER_ALLOWLIST (lib/folder-policy.mjs). Tool results never include pre-authenticated download
 * URLs or sharing-link URLs (lib/tool-output.mjs). `download_item` is hand-written so the download URL is fetched
 * without the bearer token and never returned (lib/download-item.mjs).
 */
import { DOWNLOAD_DIR_ENV, downloadItemOperation } from "./lib/download-item.mjs";
import { FOLDER_ALLOWLIST_ENV, guardToolFolder } from "./lib/folder-policy.mjs";
import { GRAPH_ERRORS } from "./lib/graph-errors.mjs";
import { defineTenantAwarePlugin, TENANT_ENV } from "./lib/graph-tenant.mjs";
import { wrapSearchQuery } from "./lib/search-query.mjs";
import { stripUrlsForTools } from "./lib/tool-output.mjs";

const UPLOAD_DIR_ENV = "ONEDRIVE_UPLOAD_DIR";
const ITEM_ID = { in: "path", type: "string", required: true, description: "Item id (from list_children, search or get_item), or root" };
const PARENT_ID = { in: "path", type: "string", required: true, description: 'Parent folder id, or "root"' };
const ITEM_SUMMARY_FIELDS = ["id", "name", "size", "file", "folder", "parentReference", "createdDateTime", "lastModifiedDateTime", "lastModifiedBy", "webUrl"];
const CONFLICT_BEHAVIORS = ["fail", "replace", "rename"];
const graphPage = (maxLimit, defaultLimit = 50) => ({ dataPath: "value", nextUrlPath: '["@odata.nextLink"]', limitParam: "$top", maxLimit, defaultLimit });
const selectParam = (defaultFields) => ({ in: "query", type: "array", items: { type: "string" }, wireName: "$select", ...(defaultFields ? { default: defaultFields } : {}), description: "Properties to return" });
const orderByParam = { in: "query", type: "string", wireName: "$orderby", description: "e.g. name, lastModifiedDateTime desc (personal accounts support name and size only)" };
const listParams = { select: selectParam(ITEM_SUMMARY_FIELDS), order_by: orderByParam };

const readOperations = [
  { name: "get_drive", title: "Get drive", description: "The user's OneDrive: id, type (personal or business), owner and storage quota", path: "/me/drive" },
  { name: "list_drives", title: "List drives", description: "Drives the user can reach directly (usually one)", path: "/me/drives", response: graphPage(200) },
  { name: "list_root_children", title: "List root", description: "Files and folders in the root of the drive", path: "/me/drive/root/children", params: listParams, response: graphPage(200) },
  { name: "list_children", title: "List folder", description: "Files and folders in a folder", path: "/me/drive/items/{item_id}/children", params: { item_id: ITEM_ID, ...listParams }, response: graphPage(200) },
  { name: "get_item", title: "Get item", description: "Metadata of a file or folder by id", path: "/me/drive/items/{item_id}", params: { item_id: ITEM_ID, select: selectParam() } },
  {
    name: "get_item_by_path",
    title: "Get item by path",
    description: 'Metadata of a file or folder by its path from the root, e.g. "Documents/Reports/q3.pdf"',
    path: "/me/drive/root:/{+item_path}:",
    params: { item_path: { in: "path", type: "string", required: true, description: 'Path below the root without a leading slash, e.g. "Documents/q3.pdf"' }, select: selectParam() },
  },
  {
    name: "search",
    title: "Search",
    description: "Search the drive's file names, metadata and content",
    // lib/search-query.mjs doubles single quotes for the OData string.
    path: "/me/drive/root/search(q='{query}')",
    params: { query: { in: "path", type: "string", required: true, description: "Search text" }, select: selectParam(ITEM_SUMMARY_FIELDS) },
    response: graphPage(200),
  },
  { name: "list_permissions", title: "List sharing", description: "Who a file or folder is shared with (roles, users, link type and scope; link URLs are left out for agents)", path: "/me/drive/items/{item_id}/permissions", params: { item_id: ITEM_ID }, response: { dataPath: "value" } },
];

const writeOperations = [
  {
    name: "upload_file",
    title: "Upload file",
    description: `Upload a file up to 250 MB (https URL, or an absolute path inside $${UPLOAD_DIR_ENV}) into a folder, creating or replacing it`,
    method: "PUT",
    path: "/me/drive/items/{parent_id}:/{file_name}:/content",
    write: "unsafe",
    checkHint: "list_children of the folder and look for the name",
    bodyMode: "file",
    fileBody: { fileDirEnv: UPLOAD_DIR_ENV, maxFileBytes: 250 * 1024 * 1024 },
    timeoutMs: 540000,
    minRequestMs: 240000,
    params: {
      parent_id: PARENT_ID,
      file_name: { in: "path", type: "string", required: true, description: "File name in OneDrive, e.g. report.pdf" },
      file: { in: "body", type: "string", file: true, required: true },
      conflict_behavior: { in: "query", type: "string", enum: CONFLICT_BEHAVIORS, wireName: "@microsoft.graph.conflictBehavior", description: "When the name exists: replace (default), rename or fail" },
    },
  },
  {
    name: "create_folder",
    title: "Create folder",
    description: "Create a folder in a parent folder (parent_id root for the top level)",
    method: "POST",
    path: "/me/drive/items/{parent_id}/children",
    write: "unsafe",
    checkHint: "list_children of the parent and look for the name",
    params: {
      parent_id: PARENT_ID,
      name: { in: "body", type: "string", required: true, minLength: 1 },
      conflict_behavior: { in: "body", type: "string", enum: CONFLICT_BEHAVIORS, default: "fail", wireName: '["@microsoft.graph.conflictBehavior"]' },
    },
    constants: { body: { folder: {} } },
  },
  {
    name: "update_item",
    title: "Rename or move",
    description: "Rename a file or folder, change its description, or move it to another folder",
    method: "PATCH",
    path: "/me/drive/items/{item_id}",
    write: "idempotent",
    params: {
      item_id: ITEM_ID,
      name: { in: "body", type: "string", minLength: 1 },
      description: { in: "body", type: "string" },
      parent_id: { in: "body", type: "string", wireName: "parentReference.id", description: 'Folder id to move into, or "root"' },
    },
  },
  {
    name: "copy_item",
    title: "Copy item",
    description: "Copy a file or folder (asynchronous: Graph answers 202 and copies in the background)",
    method: "POST",
    path: "/me/drive/items/{item_id}/copy",
    write: "unsafe",
    checkHint: "list_children of the destination folder after a few seconds",
    params: {
      item_id: ITEM_ID,
      parent_id: { in: "body", type: "string", wireName: "parentReference.id", description: "Destination folder id (default: the same folder)" },
      parent_drive_id: { in: "body", type: "string", wireName: "parentReference.driveId", description: "Destination drive id, when it is another drive" },
      name: { in: "body", type: "string", description: "Name of the copy (required when copying into the same folder)" },
      conflict_behavior: { in: "query", type: "string", enum: CONFLICT_BEHAVIORS, wireName: "@microsoft.graph.conflictBehavior" },
    },
  },
  {
    name: "create_sharing_link",
    title: "Create sharing link",
    description: "Create a view, edit or embed link (anonymous links let anyone with the URL open the item)",
    method: "POST",
    path: "/me/drive/items/{item_id}/createLink",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_permissions for the item",
    params: {
      item_id: ITEM_ID,
      link_type: { in: "body", type: "string", required: true, enum: ["view", "edit", "embed"], wireName: "type" },
      scope: { in: "body", type: "string", enum: ["anonymous", "organization", "users"], description: "Who the link works for (default depends on the tenant)" },
      expiration_date_time: { in: "body", type: "string", wireName: "expirationDateTime", description: "ISO 8601 expiry" },
      password: { in: "body", type: "string", description: "Link password (personal OneDrive only)" },
    },
  },
  {
    name: "invite",
    title: "Share with people",
    description: "Give people access to an item and optionally email them an invitation",
    method: "POST",
    path: "/me/drive/items/{item_id}/invite",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_permissions for the item",
    params: {
      item_id: ITEM_ID,
      recipients: { in: "body", type: "array", required: true, items: { type: "object" }, description: 'e.g. [{"email": "ada@example.com"}]' },
      roles: { in: "body", type: "array", required: true, items: { type: "string", enum: ["read", "write"] } },
      require_sign_in: { in: "body", type: "boolean", default: true, wireName: "requireSignIn" },
      send_invitation: { in: "body", type: "boolean", default: false, wireName: "sendInvitation" },
      message: { in: "body", type: "string", description: "Invitation text (max 2000 characters)" },
    },
  },
  { name: "delete_item", title: "Delete item", description: "Move a file or folder to the recycle bin", method: "DELETE", path: "/me/drive/items/{item_id}", write: "idempotent", nodeOnly: true, params: { item_id: ITEM_ID } },
];

const buildSpec = (tokenUrl) => ({
  name: "onedrive",
  version: "0.1.0",
  description: "OneDrive (Microsoft Graph): browse, search, download to a directory, upload up to 250 MB, folders, rename/move/copy (agents: folder allowlist), sharing links and deletes node only",
  apiName: "Microsoft Graph",
  baseUrl: "https://graph.microsoft.com/v1.0",
  toolUserToken: true,
  auth: {
    type: "oauth2",
    grant: "refresh_token",
    tokenUrl,
    clientIdEnv: "MICROSOFT_CLIENT_ID",
    clientSecretEnv: "MICROSOFT_CLIENT_SECRET",
    refreshTokenEnv: "MICROSOFT_REFRESH_TOKEN",
    // The scopes the user consented to for the app (Files.ReadWrite at least), shared with the microsoft-graph plugin.
    scope: "https://graph.microsoft.com/.default offline_access",
  },
  extraEnv: [TENANT_ENV, FOLDER_ALLOWLIST_ENV, DOWNLOAD_DIR_ENV],
  limits: { timeout_ms: 600000 },
  // Truncation happens after the URLs are stripped (lib/tool-output.mjs).
  toolOutput: false,
  errors: { ...GRAPH_ERRORS, kindByCode: { nameAlreadyExists: "invalid_input", quotaLimitReached: "invalid_input", resourceModified: "invalid_input", ...GRAPH_ERRORS.kindByCode } },
  apiRequest: { examplePath: "/me/drive/root/delta" },
  operations: [...readOperations, ...writeOperations],
});

const folderGuarded = new Set(["upload_file", "create_folder", "update_item", "copy_item"]);
const tenantDefinition = defineTenantAwarePlugin(buildSpec);
const wrapOperation = (operation) => {
  const searchWrapped = operation.name === "search" ? wrapSearchQuery(operation) : operation;
  return stripUrlsForTools(folderGuarded.has(operation.name) ? guardToolFolder(searchWrapped) : searchWrapped);
};
const declarativeOperations = tenantDefinition.operations.map(wrapOperation);
const apiRequestIndex = declarativeOperations.findIndex((operation) => operation.name === "api_request");

export const pluginDefinition = {
  ...tenantDefinition,
  operations: [...declarativeOperations.slice(0, apiRequestIndex), stripUrlsForTools(downloadItemOperation), ...declarativeOperations.slice(apiRequestIndex)],
};
