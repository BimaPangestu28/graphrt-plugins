/**
 * salesforce plugin definition: the Salesforce REST API (https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/)
 * for one org. SOQL queries (with query-more paging), SOSL search, sObject records (get, create, update, upsert by
 * external id), describe, limits, updated/deleted ids and recently viewed records. Built with the declarative REST
 * layer (docs/declarative-plugins.md); the instance URL, API version and OAuth grant come from the environment
 * (lib/salesforce-org.mjs).
 *
 * Agent policy: reads, create, update and upsert are tools; delete is node only.
 */
import {
  API_VERSION_ENV,
  buildInstanceBaseUrl,
  CLIENT_ID_ENV,
  CLIENT_SECRET_ENV,
  defineOrgAwarePlugin,
  extractQueryLocator,
  INSTANCE_URL_ENV,
  LOGIN_URL_ENV,
  REFRESH_TOKEN_ENV,
  SALESFORCE_HOST_SUFFIX,
} from "./lib/salesforce-org.mjs";

const SOBJECT = { in: "path", type: "string", required: true, description: "sObject API name, e.g. Account, Contact, Opportunity, Invoice__c" };
const RECORD_ID = { in: "path", type: "string", required: true, description: "15- or 18-character record id" };
const RECORD_FIELDS = { in: "body", type: "object", required: true, description: 'Field API names and values, e.g. {"Name": "Acme", "Industry": "Retail"}' };
const SOQL = { in: "query", type: "string", required: true, minLength: 1, wireName: "q", description: "SOQL, e.g. SELECT Id, Name FROM Account WHERE Industry = 'Retail' LIMIT 50" };
const DATE_RANGE = {
  start: { in: "query", type: "string", required: true, description: "ISO 8601 start, e.g. 2026-11-01T00:00:00Z (within the last 30 days)" },
  end: { in: "query", type: "string", required: true, description: "ISO 8601 end, e.g. 2026-11-19T00:00:00Z" },
};
const QUERY_HINT = "Results come in batches (2,000 by default): when `done` is false, pass `nextRecordsUrl` to query_more";

const metadataOperations = [
  { name: "get_limits", title: "Org limits", description: "Daily API requests and other org limits with Max and Remaining", path: "/limits" },
  { name: "describe_global", title: "List objects", description: "Every sObject in the org (name, label, keyPrefix, queryable, createable, ...)", path: "/sobjects", response: { dataPath: "sobjects" } },
  { name: "describe_sobject", title: "Describe object", description: "Fields (types, picklist values, required), relationships and record types of an sObject", path: "/sobjects/{sobject}/describe", params: { sobject: SOBJECT } },
];

const queryOperations = [
  { name: "query", title: "SOQL query", description: `Run a SOQL query. ${QUERY_HINT}`, path: "/query", params: { soql: SOQL } },
  { name: "query_all", title: "SOQL query incl. deleted", description: `Run a SOQL query that also returns deleted and archived records. ${QUERY_HINT}`, path: "/queryAll", params: { soql: SOQL } },
  {
    name: "query_more",
    title: "Next query batch",
    description: "The next batch of a query or query_all result",
    path: "/query/{query_locator}",
    params: { query_locator: { in: "path", type: "string", required: true, description: "nextRecordsUrl of the previous batch, or just its locator (01g...-2000)" } },
  },
  {
    name: "search",
    title: "SOSL search",
    description: "Text search across objects with SOSL",
    path: "/search",
    params: { sosl: { in: "query", type: "string", required: true, minLength: 1, wireName: "q", description: "SOSL, e.g. FIND {Acme} IN NAME FIELDS RETURNING Account(Id, Name), Contact(Id, Email)" } },
    response: { dataPath: "searchRecords" },
  },
  {
    name: "list_recently_viewed",
    title: "Recently viewed",
    description: "Records the user viewed or referenced most recently",
    path: "/recent",
    params: { max_records: { in: "query", type: "integer", min: 1, max: 200, wireName: "limit", description: "Maximum records (default 200)" } },
  },
  { name: "get_updated", title: "Updated record ids", description: "Ids of records of an sObject updated in a time range", path: "/sobjects/{sobject}/updated/", params: { sobject: SOBJECT, ...DATE_RANGE } },
  { name: "get_deleted", title: "Deleted record ids", description: "Ids of records of an sObject deleted in a time range (still in the recycle bin)", path: "/sobjects/{sobject}/deleted/", params: { sobject: SOBJECT, ...DATE_RANGE } },
];

const recordOperations = [
  {
    name: "get_record",
    title: "Get record",
    description: "One record by id",
    path: "/sobjects/{sobject}/{record_id}",
    params: { sobject: SOBJECT, record_id: RECORD_ID, fields: { in: "query", type: "array", items: { type: "string" }, maxItems: 500, description: "Fields to return (default: all)" } },
  },
  {
    name: "get_record_by_external_id",
    title: "Get record by external id",
    description: "One record by the value of an external id field",
    path: "/sobjects/{sobject}/{external_id_field}/{external_id}",
    params: {
      sobject: SOBJECT,
      external_id_field: { in: "path", type: "string", required: true, description: "External id field API name, e.g. Customer_Number__c" },
      external_id: { in: "path", type: "string", required: true, description: "Value of the external id field" },
      fields: { in: "query", type: "array", items: { type: "string" }, maxItems: 500, description: "Fields to return (default: all)" },
    },
  },
  {
    name: "create_record",
    title: "Create record",
    description: "Create a record; returns {id, success, errors}",
    method: "POST",
    path: "/sobjects/{sobject}",
    bodyMode: "raw",
    write: "unsafe",
    checkHint: "query the sObject for the record (e.g. by Name and CreatedDate = TODAY)",
    params: { sobject: SOBJECT, fields: RECORD_FIELDS },
  },
  {
    name: "update_record",
    title: "Update record",
    description: "Update fields of a record (fields not given are kept); no content on success",
    method: "PATCH",
    path: "/sobjects/{sobject}/{record_id}",
    bodyMode: "raw",
    // Setting the same field values again is harmless.
    write: "idempotent",
    params: { sobject: SOBJECT, record_id: RECORD_ID, fields: RECORD_FIELDS },
  },
  {
    name: "upsert_record",
    title: "Upsert record",
    description: "Create or update the record with this external id value (201 created, 200/204 updated)",
    method: "PATCH",
    path: "/sobjects/{sobject}/{external_id_field}/{external_id}",
    bodyMode: "raw",
    // Keyed by the external id: a repeat updates the same record with the same values.
    write: "idempotent",
    params: {
      sobject: SOBJECT,
      external_id_field: { in: "path", type: "string", required: true, description: "External id field API name, e.g. Customer_Number__c" },
      external_id: { in: "path", type: "string", required: true, description: "Value of the external id field" },
      fields: { ...RECORD_FIELDS, description: "Other field values (not the external id field)" },
    },
  },
  {
    name: "delete_record",
    title: "Delete record",
    description: "Move a record to the recycle bin",
    method: "DELETE",
    path: "/sobjects/{sobject}/{record_id}",
    write: "idempotent",
    nodeOnly: true,
    params: { sobject: SOBJECT, record_id: RECORD_ID },
  },
];

// Errors are an array: [{"message": "Session expired or invalid", "errorCode": "INVALID_SESSION_ID"}]
// (https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/errorcodes.htm).
const SALESFORCE_ERRORS = {
  messagePath: ["0.message", "error_description", "message"],
  codePath: "0.errorCode",
  kindByCode: {
    // INVALID_SESSION_ID (an expired token) makes the layer refresh the OAuth token once and retry.
    INSUFFICIENT_ACCESS: "permission_denied",
    INVALID_SESSION_ID: "auth_error",
    INVALID_AUTH_HEADER: "auth_error",
    REQUEST_LIMIT_EXCEEDED: "rate_limited",
    INSUFFICIENT_ACCESS_OR_READONLY: "permission_denied",
    API_DISABLED_FOR_ORG: "permission_denied",
    API_CURRENTLY_DISABLED: "permission_denied",
    NOT_FOUND: "not_found",
    ENTITY_IS_DELETED: "not_found",
    MALFORMED_ID: "invalid_input",
    MALFORMED_QUERY: "invalid_input",
    MALFORMED_SEARCH: "invalid_input",
    INVALID_FIELD: "invalid_input",
    INVALID_TYPE: "invalid_input",
    INVALID_QUERY_LOCATOR: "invalid_input",
    INVALID_QUERY_FILTER_OPERATOR: "invalid_input",
    JSON_PARSER_ERROR: "invalid_input",
    REQUIRED_FIELD_MISSING: "invalid_input",
    FIELD_CUSTOM_VALIDATION_EXCEPTION: "invalid_input",
    INVALID_FIELD_FOR_INSERT_UPDATE: "invalid_input",
    STRING_TOO_LONG: "invalid_input",
    DUPLICATES_DETECTED: "invalid_input",
    DUPLICATE_VALUE: "invalid_input",
    EXCEEDED_ID_LIMIT: "invalid_input",
  },
};

const buildSpec = ({ grant, tokenUrl }) => ({
  name: "salesforce",
  version: "0.1.0",
  description: "Salesforce REST API: SOQL queries with paging, SOSL search, records (get, create, update, upsert by external id), describe and limits; deletes are node only",
  apiName: "Salesforce REST API",
  baseUrl: buildInstanceBaseUrl,
  allowedHostSuffix: SALESFORCE_HOST_SUFFIX,
  auth: {
    type: "oauth2",
    grant,
    tokenUrl,
    clientIdEnv: CLIENT_ID_ENV,
    clientSecretEnv: CLIENT_SECRET_ENV,
    ...(grant === "refresh_token" ? { refreshTokenEnv: REFRESH_TOKEN_ENV } : {}),
  },
  extraEnv: [INSTANCE_URL_ENV, LOGIN_URL_ENV, API_VERSION_ENV, REFRESH_TOKEN_ENV],
  errors: SALESFORCE_ERRORS,
  apiRequest: { examplePath: "/sobjects/Account/listviews" },
  operations: [...metadataOperations, ...queryOperations, ...recordOperations],
});

// query_more also takes the full nextRecordsUrl (query and queryAll locators both work on /query/{locator}).
const acceptNextRecordsUrl = (operation) => ({
  ...operation,
  run: (context) => {
    const locator = context.args?.query_locator;
    return operation.run(typeof locator === "string" ? { ...context, args: { ...context.args, query_locator: extractQueryLocator(locator) } } : context);
  },
});

const orgDefinition = defineOrgAwarePlugin(buildSpec);
export const pluginDefinition = { ...orgDefinition, operations: orgDefinition.operations.map((operation) => (operation.name === "query_more" ? acceptNextRecordsUrl(operation) : operation)) };
