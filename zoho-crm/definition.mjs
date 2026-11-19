/**
 * zoho-crm plugin definition: the Zoho CRM REST API v8 (https://www.zoho.com/crm/developer/docs/api/v8/).
 * Records of any module (list, get, search, COQL, related records, insert, update, upsert, delete), module, field
 * and related-list metadata, users and the organization. Built with the declarative REST layer
 * (docs/declarative-plugins.md); the data center and the Zoho OAuth credentials come from the environment
 * (lib/zoho-auth.mjs).
 *
 * Agent policy: reads, insert, update and upsert are tools (with no workflow, approval or blueprint triggers unless
 * `trigger` asks for them); delete is node only. api_request as a tool may only read standard-module records and
 * metadata, users and the org (lib/api-request-allowlist.mjs): other GET endpoints return Deluge variables (API
 * keys) and notification channel tokens.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { PluginError } from "./lib/shared/graphrt-plugin.mjs";
import { restrictApiRequestToReadPaths } from "./lib/api-request-allowlist.mjs";
import { ACCESS_TOKEN_ENV, buildApiBaseUrl, createZohoAuth, DATA_CENTER_ENV, withZohoCredentials } from "./lib/zoho-auth.mjs";

const STANDARD_MODULES = [
  "Leads", "Contacts", "Accounts", "Deals", "Tasks", "Events", "Calls", "Notes", "Products", "Quotes", "Sales_Orders",
  "Purchase_Orders", "Invoices", "Campaigns", "Vendors", "Price_Books", "Cases", "Solutions", "Appointments__s", "Services__s",
];
// api_request tool calls may read only these (custom modules are still readable through list_records/get_record).
export const TOOL_READ_PATH_PREFIXES = [
  ...STANDARD_MODULES.map((moduleName) => `/${moduleName}`),
  "/settings/modules",
  "/settings/fields",
  "/settings/layouts",
  "/settings/related_lists",
  "/settings/custom_views",
  "/settings/pipeline",
  "/users",
  "/org",
];
const SEARCH_TERMS = ["criteria", "email", "phone", "word"];
const MODULE = { in: "path", type: "string", required: true, description: "Module API name, e.g. Leads, Contacts, Accounts, Deals, Tasks, Notes, or a custom module" };
const RECORD_ID = { in: "path", type: "string", required: true, description: "Record id" };
const fieldList = (required) => ({
  in: "query",
  type: "array",
  items: { type: "string" },
  maxItems: 50,
  ...(required ? { required: true } : {}),
  description: "Field API names to return (up to 50), e.g. [Last_Name, Email, Company]",
});
const sortParams = {
  sort_by: { in: "query", type: "string", enum: ["id", "Created_Time", "Modified_Time"], description: "Sort field (default id; not with cvid)" },
  sort_order: { in: "query", type: "string", enum: ["asc", "desc"], description: "Default desc" },
};
const convertedParam = { in: "query", type: "string", enum: ["true", "false", "both"], description: "Leads: converted records too (default false)" };
// Get Records and related records page with page_token (needed past 2,000 records; valid 24 hours).
const tokenPage = { dataPath: "data", cursorPath: "info.next_page_token", cursorParam: "page_token", limitParam: "per_page", hasMorePath: "info.more_records", maxLimit: 200, defaultLimit: 200 };
const numberedPage = (dataPath) => ({ dataPath, pagePagination: { pageParam: "page", sizeParam: "per_page" }, maxLimit: 200, defaultLimit: 200 });
const TRIGGER = {
  in: "body",
  type: "array",
  items: { type: "string", enum: ["workflow", "approval", "blueprint", "pathfinder", "orchestration"] },
  default: [],
  description: "Automation to run for these records; [] (default) runs none, so no workflow emails or field updates",
};
const RECORDS = (description) => ({ in: "body", type: "array", items: { type: "object" }, required: true, maxItems: 100, wireName: "data", description });

const metadataOperations = [
  { name: "list_modules", title: "List modules", description: "Modules of the org (api_name, plural_label, api_supported, ...)", path: "/settings/modules", response: { dataPath: "modules" } },
  {
    name: "list_fields",
    title: "List fields",
    description: "Fields of a module (api_name, data_type, picklist values, mandatory)",
    path: "/settings/fields",
    params: { module: { in: "query", type: "string", required: true, description: "Module API name, e.g. Leads" }, field_type: { in: "query", type: "string", enum: ["all", "unused"], wireName: "type" } },
    response: { dataPath: "fields" },
  },
  {
    name: "list_related_lists",
    title: "List related lists",
    description: "Related lists of a module (api_name for list_related_records)",
    path: "/settings/related_lists",
    params: { module: { in: "query", type: "string", required: true, description: "Module API name, e.g. Accounts" } },
    response: { dataPath: "related_lists" },
  },
  {
    name: "list_users",
    title: "List users",
    description: "Users of the org",
    path: "/users",
    params: {
      user_type: {
        in: "query",
        type: "string",
        wireName: "type",
        enum: ["AllUsers", "ActiveUsers", "DeactiveUsers", "ConfirmedUsers", "NotConfirmedUsers", "DeletedUsers", "ActiveConfirmedUsers", "AdminUsers", "ActiveConfirmedAdmins", "CurrentUser"],
        description: "Which users (default AllUsers)",
      },
    },
    response: numberedPage("users"),
  },
  { name: "get_org", title: "Organization", description: "The org's company details, time zone, currency and license", path: "/org", response: { dataPath: "org.0" } },
];

const readOperations = [
  {
    name: "list_records",
    title: "List records",
    description: "Records of a module (200 a page; next_cursor is the page_token)",
    path: "/{module}",
    params: {
      module: MODULE,
      fields: fieldList(true),
      cvid: { in: "query", type: "string", description: "Custom view id (not with sort_by)" },
      ids: { in: "query", type: "array", items: { type: "string" }, maxItems: 100, description: "Only these record ids" },
      ...sortParams,
      converted: convertedParam,
    },
    response: tokenPage,
  },
  {
    name: "get_record",
    title: "Get record",
    description: "One record by id",
    path: "/{module}/{record_id}",
    params: { module: MODULE, record_id: RECORD_ID, fields: fieldList(false) },
    response: { dataPath: "data.0" },
  },
  {
    name: "search_records",
    title: "Search records",
    description: "Search a module by criteria, email, phone or word (one of them; at most 2,000 results; new records can take a moment to be searchable)",
    path: "/{module}/search",
    params: {
      module: MODULE,
      criteria: { in: "query", type: "string", description: "e.g. ((Last_Name:equals:Burns)and(First_Name:starts_with:Ma)); escape ( ) , in values with \\" },
      email: { in: "query", type: "string", description: "Search every email field" },
      phone: { in: "query", type: "string", description: "Search every phone field" },
      word: { in: "query", type: "string", description: "Global text search" },
      converted: convertedParam,
      approved: { in: "query", type: "string", enum: ["true", "false", "both"], description: "Default true" },
    },
    response: numberedPage("data"),
  },
  {
    name: "coql_query",
    title: "COQL query",
    description: "Run a COQL SELECT, e.g. select Last_Name, Email from Leads where Lead_Status = 'Contacted' limit 0, 200 (max 2,000 rows a call; info.more_records)",
    method: "POST",
    path: "/coql",
    // A query reads only: repeating it is harmless.
    write: "idempotent",
    params: { select_query: { in: "body", type: "string", required: true, minLength: 1, description: "COQL statement (SELECT only)" } },
  },
  {
    name: "list_related_records",
    title: "List related records",
    description: "Records in a related list of a record, e.g. Notes, Contacts or Deals of an Account",
    path: "/{module}/{record_id}/{related_list}",
    params: {
      module: MODULE,
      record_id: RECORD_ID,
      related_list: { in: "path", type: "string", required: true, description: "Related list API name (list_related_lists), e.g. Notes" },
      fields: fieldList(true),
      ...sortParams,
    },
    response: tokenPage,
  },
];

const writeOperations = [
  {
    name: "insert_records",
    title: "Insert records",
    description: "Create up to 100 records; data[] reports each record's status (HTTP 207 when some failed)",
    method: "POST",
    path: "/{module}",
    write: "unsafe",
    checkHint: "search_records or coql_query for the new records (e.g. by Email or Created_Time)",
    params: { module: MODULE, records: RECORDS('Records with field API names, e.g. [{"Last_Name": "Daly", "Email": "p.daly@example.com"}]'), trigger: TRIGGER },
  },
  {
    name: "update_records",
    title: "Update records",
    description: "Update up to 100 records; each needs its id (fields not given are kept)",
    method: "PUT",
    path: "/{module}",
    // Not retried after a 5xx: the update may have run workflows, approvals or blueprints (`trigger`).
    write: "unsafe",
    checkHint: "get_record for each id and compare the fields",
    params: { module: MODULE, records: RECORDS('Records with id and the fields to change, e.g. [{"id": "4876876000000376008", "Lead_Status": "Contacted"}]'), trigger: TRIGGER },
  },
  {
    name: "upsert_records",
    title: "Upsert records",
    description: "Update records that match on duplicate-check fields, insert the rest (up to 100)",
    method: "POST",
    path: "/{module}/upsert",
    // Without a unique match a repeat inserts again, so it is not retried blindly.
    write: "unsafe",
    checkHint: "search_records on the duplicate-check field values",
    params: {
      module: MODULE,
      records: RECORDS("Records with field API names"),
      duplicate_check_fields: { in: "body", type: "array", items: { type: "string" }, maxItems: 10, description: "Fields to match on, in order (default: the module's system field, e.g. Email for Leads, then unique fields)" },
      trigger: TRIGGER,
    },
  },
  {
    name: "delete_records",
    title: "Delete records",
    description: "Move up to 100 records to the recycle bin",
    method: "DELETE",
    path: "/{module}",
    write: "idempotent",
    nodeOnly: true,
    params: {
      module: MODULE,
      ids: { in: "query", type: "array", items: { type: "string" }, required: true, maxItems: 100, description: "Record ids" },
      wf_trigger: { in: "query", type: "boolean", description: "Run delete workflows (Zoho default true)" },
    },
  },
];

// Errors are {"code": "INVALID_TOKEN", "details": {}, "message": "invalid oauth token", "status": "error"}.
const ZOHO_ERRORS = {
  messagePath: ["message", "data.0.message"],
  codePath: "code",
  kindByCode: {
    INVALID_DATA: "invalid_input",
    INVALID_TOKEN: "auth_error",
    AUTHENTICATION_FAILURE: "auth_error",
    OAUTH_SCOPE_MISMATCH: "permission_denied",
    NO_PERMISSION: "permission_denied",
    AUTHORIZATION_FAILED: "permission_denied",
    FEATURE_NOT_ENABLED: "permission_denied",
    FEATURE_NOT_SUPPORTED: "permission_denied",
    INVALID_URL_PATTERN: "not_found",
    INVALID_MODULE: "invalid_input",
    INVALID_QUERY: "invalid_input",
    SYNTAX_ERROR: "invalid_input",
    MANDATORY_NOT_FOUND: "invalid_input",
    REQUIRED_PARAM_MISSING: "invalid_input",
    DUPLICATE_DATA: "invalid_input",
    MULTIPLE_OR_MULTI_ERRORS: "invalid_input",
    LIMIT_REACHED: "invalid_input",
    INVALID_REQUEST_METHOD: "invalid_input",
    ALREADY_MODIFIED: "invalid_input",
    TOO_MANY_REQUESTS: "rate_limited",
  },
};

export const restDefinition = defineRestPlugin({
  name: "zoho-crm",
  version: "0.1.0",
  description: "Zoho CRM API v8 (any data center): list, get, search and COQL-query records, related records, insert, update and upsert, module and field metadata, users; deletes are node only",
  apiName: "Zoho CRM API",
  baseUrl: buildApiBaseUrl,
  auth: createZohoAuth(),
  extraEnv: [DATA_CENTER_ENV, ACCESS_TOKEN_ENV],
  errors: ZOHO_ERRORS,
  apiRequest: { examplePath: "/settings/layouts?module=Leads" },
  operations: [...metadataOperations, ...readOperations, ...writeOperations],
});

// Zoho answers a search without any term with a 400; refusing it first gives a clear message.
const requireSearchTerm = (operation) => ({
  ...operation,
  run: (context) => {
    if (!SEARCH_TERMS.some((termName) => typeof context.args?.[termName] === "string" && context.args[termName].trim() !== "")) {
      throw new PluginError("search_records needs one of criteria, email, phone or word", { kind: "invalid_input" });
    }
    return operation.run(context);
  },
});
const guardApiRequest = (operation) => restrictApiRequestToReadPaths(operation, TOOL_READ_PATH_PREFIXES);

/**
 * Applies the plugin's wrappers: Zoho credentials, the search-term check and (unless turned off for the contract
 * suite, whose api_request probe uses an arbitrary path) the api_request tool path allowlist.
 *
 * @param definition - Definition from defineRestPlugin (object)
 * @param options - `{guardApiRequestPaths}` (object)
 * @returns Wrapped definition (object)
 */
export function wrapZohoDefinition(definition, { guardApiRequestPaths = true } = {}) {
  const wrappers = { search_records: requireSearchTerm, ...(guardApiRequestPaths ? { api_request: guardApiRequest } : {}) };
  const wrapped = { ...definition, operations: definition.operations.map((operation) => wrappers[operation.name]?.(operation) ?? operation) };
  return withZohoCredentials(wrapped);
}

export const pluginDefinition = wrapZohoDefinition(restDefinition);
