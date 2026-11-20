/**
 * supabase plugin definition: table rows through the Data API (PostgREST, https://docs.postgrest.org) and files
 * through Supabase Storage (https://supabase.github.io/storage/) of one project. Built with the declarative REST
 * layer (docs/declarative-plugins.md); lib/supabase-policy.mjs adds safe filter encoding and the agent rules.
 *
 * Agent policy: reads are tools; inserts, updates, upserts, uploads and function calls need
 * SUPABASE_TOOL_ALLOW_WRITES=1 for tools; row deletes, object deletes and signed URLs are node only; tool uploads
 * never overwrite; api_request as a tool only reaches /rest/v1 reads and storage reads. The `call_function` tool
 * follows SUPABASE_TOOL_RPC_ALLOWLIST, SUPABASE_TOOL_TIMEOUT_MS and SUPABASE_TOOL_MAX_ROWS (lib/rpc-tool.mjs).
 *
 * SUPABASE_TOOL_MODE=user_rpc (multi-user chatbots): the only tool is a per-user `call_function` that sends the end
 * user's JWT from the host's per-call tool context, never SUPABASE_USER_JWT or the key, and needs the allowlist.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";
import { applyRowQueries, applyUpsertResolution, refuseToolOverwrites, RETURN_PREFERENCE } from "./lib/supabase-policy.mjs";
import { FILTER_OPERATORS } from "./lib/postgrest-query.mjs";
import { applyRpcToolLimits, createUserRpcOperation, isUserRpcMode, RPC_TOOL_ENV } from "./lib/rpc-tool.mjs";
import { createErrorParser } from "./lib/shared/rest-errors.mjs";

const WRITE_OPT_IN = "optIn:SUPABASE_TOOL_ALLOW_WRITES";
const URL_ENV = "SUPABASE_URL";
const USER_JWT_ENV = "SUPABASE_USER_JWT";
const MAX_ROWS = 1000;
// Legacy anon/service_role keys are JWTs (eyJ...) and also go in Authorization; new sb_publishable_/sb_secret_
// keys must only be sent as `apikey` (https://supabase.com/docs/guides/api/api-keys).
const LEGACY_JWT_PREFIX = "eyJ";

/**
 * Resolves the project URL: https (http only on localhost for `supabase start`), no path, query or credentials.
 *
 * @param environment - Environment variables (object)
 * @returns Project origin, e.g. "https://abcdefghijklmnopqrst.supabase.co" (string)
 * @throws Error - Missing or malformed SUPABASE_URL
 */
function resolveProjectUrl(environment) {
  const rawUrl = environment[URL_ENV]?.trim();
  if (!rawUrl) throw new Error(`set ${URL_ENV} to your project URL, e.g. https://<project-ref>.supabase.co`);
  const projectUrl = new URL(rawUrl);
  if (projectUrl.pathname.replace(/\/+$/, "") !== "" || projectUrl.search || projectUrl.hash) {
    throw new Error(`${URL_ENV} must be the project origin only (no path such as /rest/v1, no query)`);
  }
  const hostname = projectUrl.hostname.toLowerCase();
  if (hostname.endsWith(".supabase.co") && !/^[a-z0-9-]+\.supabase\.co$/.test(hostname)) {
    throw new Error(`${URL_ENV} must be https://<project-ref>.supabase.co or your custom domain`);
  }
  return projectUrl.origin;
}

function authorizeSupabase({ headers, credential, environment }) {
  headers.apikey = credential;
  const userJwt = environment[USER_JWT_ENV]?.trim();
  if (userJwt) headers.authorization = `Bearer ${userJwt}`;
  else if (credential.startsWith(LEGACY_JWT_PREFIX)) headers.authorization = `Bearer ${credential}`;
  return userJwt ? [userJwt] : [];
}

// --- shared params ------------------------------------------------------------------------------------

const tableParam = { in: "path", type: "string", required: true, description: "Table or view name in the exposed schema" };
const readSchemaParam = { in: "header", type: "string", wireName: "Accept-Profile", description: "Schema when the Data API exposes several (default public)" };
const writeSchemaParam = { ...readSchemaParam, wireName: "Content-Profile" };
const columnsParam = {
  in: "query",
  type: "string",
  wireName: "select",
  description: "Columns to return in PostgREST select syntax, e.g. id,title,author:profiles(name) (default all)",
};
const filtersDescription =
  `Conditions, all must match: [{column, operator, value, negate?, language?}]. operator: ${FILTER_OPERATORS.join(", ")}. ` +
  'Values are quoted for you; "in" takes a list, "is" takes null/true/false/unknown, like/ilike use * as wildcard, ' +
  "language is for full-text operators. JSON columns: data->>city";
const filtersParam = (required) => ({ in: "query", type: "array", items: { type: "object" }, maxItems: 20, wireName: "and", required, description: filtersDescription });
const bucketParam = { in: "path", type: "string", required: true, description: "Bucket id" };
const objectPathParam = { in: "path", type: "string", required: true, description: "Object path inside the bucket, e.g. invoices/2026/11.pdf" };
const returnRows = { headers: { Prefer: RETURN_PREFERENCE } };

// --- rows (PostgREST) ------------------------------------------------------------------------------------

const rowOperations = [
  {
    name: "get_api_schema",
    title: "Get Data API schema",
    description: "OpenAPI description of the exposed tables, views, columns and functions (needs a secret or service_role key since Feb 2026)",
    path: "/rest/v1/",
    params: { db_schema: readSchemaParam },
  },
  {
    name: "select_rows",
    title: "Select rows",
    description: "Read rows of a table or view with filters, column selection (incl. related tables) and ordering; row level security applies to publishable/anon keys",
    path: "/rest/v1/{table}",
    params: {
      table: tableParam,
      columns: columnsParam,
      filters: filtersParam(false),
      order: { in: "query", type: "string", description: "e.g. created_at.desc,id or score.desc.nullslast" },
      db_schema: readSchemaParam,
    },
    response: { offsetPagination: { offsetParam: "offset", limitParam: "limit" }, defaultLimit: 100, maxLimit: MAX_ROWS },
  },
  {
    name: "insert_rows",
    title: "Insert rows",
    description: "Insert one or more rows and return them; missing columns get their defaults",
    method: "POST",
    path: "/rest/v1/{table}",
    write: "unsafe",
    checkHint: "select_rows with a filter on the new rows' key before inserting again",
    toolPolicy: WRITE_OPT_IN,
    bodyMode: "raw",
    params: {
      table: tableParam,
      rows: { in: "body", type: "array", items: { type: "object" }, required: true, maxItems: MAX_ROWS, description: "Rows as objects of column: value" },
      columns: columnsParam,
      db_schema: writeSchemaParam,
    },
    constants: returnRows,
  },
  {
    name: "upsert_rows",
    title: "Upsert rows",
    description: "Insert rows, or update (merge) or skip (ignore) rows whose primary key or on_conflict columns already exist",
    method: "POST",
    path: "/rest/v1/{table}",
    write: "unsafe",
    checkHint: "select_rows on the conflict key",
    toolPolicy: WRITE_OPT_IN,
    bodyMode: "raw",
    params: {
      table: tableParam,
      rows: { in: "body", type: "array", items: { type: "object" }, required: true, maxItems: MAX_ROWS, description: "Rows including the key columns" },
      on_conflict: { in: "query", type: "string", description: "Columns of a UNIQUE constraint to match on, e.g. email (default the primary key)" },
      duplicates: { in: "header", type: "string", wireName: "Prefer", enum: ["merge", "ignore"], default: "merge", description: "merge updates existing rows, ignore leaves them" },
      columns: columnsParam,
      db_schema: writeSchemaParam,
    },
  },
  {
    name: "update_rows",
    title: "Update rows",
    description: "Set column values on every row matching the filters (at least one filter required) and return the changed rows",
    method: "PATCH",
    path: "/rest/v1/{table}",
    write: "unsafe",
    checkHint: "select_rows with the same filters",
    toolPolicy: WRITE_OPT_IN,
    bodyMode: "raw",
    params: {
      table: tableParam,
      values: { in: "body", type: "object", required: true, description: "Columns to set, e.g. {\"status\": \"done\"}" },
      filters: filtersParam(true),
      columns: columnsParam,
      db_schema: writeSchemaParam,
    },
    constants: returnRows,
  },
  {
    name: "delete_rows",
    title: "Delete rows",
    description: "Delete every row matching the filters (at least one filter required) and return the deleted rows",
    method: "DELETE",
    path: "/rest/v1/{table}",
    write: "unsafe",
    checkHint: "select_rows with the same filters",
    nodeOnly: true,
    params: { table: tableParam, filters: filtersParam(true), columns: columnsParam, db_schema: writeSchemaParam },
    constants: returnRows,
  },
  {
    name: "call_function",
    title: "Call database function",
    description: "Call a Postgres function exposed by the Data API (RPC) with named arguments",
    method: "POST",
    path: "/rest/v1/rpc/{function_name}",
    write: "unsafe",
    checkHint: "read the rows the function changes",
    toolPolicy: WRITE_OPT_IN,
    // lib/rpc-tool.mjs caps tool results by rows and size (SUPABASE_TOOL_MAX_ROWS).
    toolOutput: false,
    bodyMode: "raw",
    params: {
      function_name: { in: "path", type: "string", required: true, description: "Function name" },
      arguments: { in: "body", type: "object", default: {}, description: "Named arguments, e.g. {\"user_id\": 7}" },
      db_schema: writeSchemaParam,
    },
  },
];

// --- storage ---------------------------------------------------------------------------------------------

const storageOperations = [
  {
    name: "list_buckets",
    title: "List buckets",
    description: "Storage buckets of the project with their public flag, size limit and allowed MIME types",
    path: "/storage/v1/bucket",
  },
  {
    name: "get_bucket",
    title: "Get bucket",
    description: "One storage bucket",
    path: "/storage/v1/bucket/{bucket_id}",
    params: { bucket_id: bucketParam },
  },
  {
    name: "list_objects",
    title: "List objects",
    description: "Files and folders under a prefix of a bucket (one level), with size and MIME type in metadata",
    method: "POST",
    path: "/storage/v1/object/list/{bucket_id}",
    write: "idempotent",
    params: {
      bucket_id: bucketParam,
      prefix: { in: "body", type: "string", default: "", description: 'Folder to list, e.g. "invoices/2026" ("" for the root)' },
      search: { in: "body", type: "string", description: "Only names containing this text" },
      sort_column: { in: "body", type: "string", wireName: "sortBy.column", enum: ["name", "updated_at", "created_at", "last_accessed_at"] },
      sort_order: { in: "body", type: "string", wireName: "sortBy.order", enum: ["asc", "desc"], description: "Needs sort_column" },
    },
    response: { offsetPagination: { offsetParam: "offset", limitParam: "limit" }, defaultLimit: 100, maxLimit: 1000 },
  },
  {
    name: "get_object_info",
    title: "Get object info",
    description: "Size, MIME type, ETag and timestamps of one file",
    path: "/storage/v1/object/info/authenticated/{bucket_id}/{+object_path}",
    params: { bucket_id: bucketParam, object_path: objectPathParam },
  },
  {
    name: "download_object",
    title: "Download object",
    description: "Download a file into SUPABASE_DOWNLOAD_DIR",
    path: "/storage/v1/object/authenticated/{bucket_id}/{+object_path}",
    params: { bucket_id: bucketParam, object_path: objectPathParam },
    response: { binary: { envDir: "SUPABASE_DOWNLOAD_DIR", maxBytes: 200 * 1024 * 1024 } },
  },
  {
    name: "upload_object",
    title: "Upload object",
    description: "Upload a file (https URL or a path inside SUPABASE_UPLOAD_DIR) to a bucket path; upsert overwrites (node only)",
    method: "POST",
    path: "/storage/v1/object/{bucket_id}/{+object_path}",
    write: "unsafe",
    checkHint: "get_object_info for the path",
    toolPolicy: WRITE_OPT_IN,
    bodyMode: "file",
    timeoutMs: 110000,
    fileBody: { fileDirEnv: "SUPABASE_UPLOAD_DIR", maxFileBytes: 50 * 1024 * 1024 },
    params: {
      bucket_id: bucketParam,
      object_path: objectPathParam,
      file: { in: "body", type: "string", file: true, required: true },
      upsert: { in: "header", type: "boolean", wireName: "x-upsert", default: false, description: "Overwrite an existing file (workflow nodes only)" },
      cache_control: { in: "header", type: "string", wireName: "cache-control", description: 'e.g. "max-age=3600"' },
    },
  },
  {
    name: "delete_objects",
    title: "Delete objects",
    description: "Delete up to 1000 files of a bucket by path",
    method: "DELETE",
    path: "/storage/v1/object/{bucket_id}",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_objects on the folder",
    params: { bucket_id: bucketParam, paths: { in: "body", type: "array", items: { type: "string" }, required: true, maxItems: 1000, wireName: "prefixes", description: "Object paths" } },
  },
  {
    name: "create_signed_url",
    title: "Create signed URL",
    description: "A time-limited download URL for a private file (anyone with the link can read it)",
    method: "POST",
    path: "/storage/v1/object/sign/{bucket_id}/{+object_path}",
    write: "idempotent",
    nodeOnly: true,
    params: {
      bucket_id: bucketParam,
      object_path: objectPathParam,
      expires_in: { in: "body", type: "integer", wireName: "expiresIn", required: true, min: 1, max: 604800, description: "Seconds the link is valid" },
    },
  },
];

// PostgREST: {code, details, hint, message}; gateway: {message, hint}; Storage: {statusCode, error, code, message}.
const SUPABASE_ERRORS = {
  messagePath: ["message", "msg", "error_description"],
  codePath: "code",
  kindByCode: {
    PGRST301: "auth_error",
    PGRST302: "auth_error",
    PGRST303: "auth_error",
    42501: "permission_denied",
    PGRST202: "not_found",
    PGRST205: "not_found",
    InvalidJWT: "auth_error",
    NoSuchBucket: "not_found",
    NoSuchKey: "not_found",
  },
};

const restDefinition = defineRestPlugin({
  name: "supabase",
  version: "0.1.0",
  description: "Supabase: table rows via the Data API (PostgREST) with safely encoded filters, inserts/updates/upserts and RPC, and Storage files",
  apiName: "Supabase project API (Data API /rest/v1, Storage /storage/v1)",
  limits: { timeout_ms: 130000 },
  baseUrl: resolveProjectUrl,
  auth: { type: "custom", env: "SUPABASE_KEY", authorize: authorizeSupabase },
  extraEnv: [URL_ENV, USER_JWT_ENV, "SUPABASE_TOOL_API_EXTRA_PATHS", ...RPC_TOOL_ENV],
  errors: SUPABASE_ERRORS,
  apiRequest: { examplePath: "/rest/v1/<table>?select=id&id=eq.1" },
  operations: [...rowOperations, ...storageOperations],
});

const TOOL_API_PATHS = [/^\/rest\/v1(\/.*)?$/, /^\/storage\/v1\/bucket(\/[^/]+)?$/, /^\/storage\/v1\/object\/.+$/];

const guardedDefinition = guardToolApiRequest(restDefinition, {
  allowedPaths: TOOL_API_PATHS,
  extraAllowedPathsEnv: "SUPABASE_TOOL_API_EXTRA_PATHS",
  reason: "agent tools may only read the Data API (/rest/v1) and Storage; auth admin, edge functions and other services are node only",
});
const rowQueryDefinition = applyRowQueries(guardedDefinition, {
  operationNames: ["select_rows", "update_rows", "delete_rows"],
  filterRequired: ["update_rows", "delete_rows"],
});

const policyDefinition = refuseToolOverwrites(applyUpsertResolution(rowQueryDefinition, "upsert_rows"), "upload_object");

export const pluginDefinition = {
  ...applyRpcToolLimits(policyDefinition, "call_function"),
  // user_rpc: one per-user RPC tool and nothing else (no select_rows, api_request, writes or storage).
  resolveToolOperations: (environment) =>
    isUserRpcMode(environment) ? [createUserRpcOperation({ environment, errors: SUPABASE_ERRORS, createErrorParser })] : undefined,
};
