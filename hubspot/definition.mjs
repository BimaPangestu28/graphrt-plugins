/**
 * hubspot plugin definition: HubSpot CRM through the date-versioned API 2026-09
 * (https://developers.hubspot.com/docs/api-reference/latest/overview.md; the same contracts as CRM v3/v4, which
 * HubSpot is retiring). Contacts, companies, deals and tickets (and notes, tasks, calls, meetings, products, line
 * items): list, get, search, create, update; associations; notes on records; properties, pipelines, owners.
 * Built with the declarative REST layer (docs/declarative-plugins.md); `create_note` takes plain record id lists
 * (lib/hubspot-notes.mjs).
 *
 * Agent policy: reads, creates, updates, notes and new associations are tools. Archiving records and removing
 * associations are node only. `api_request` as a tool may only read CRM and account-details paths
 * (lib/api-request-allowlist.mjs), because other GET endpoints return SMTP tokens, app and webhook settings.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { restrictApiRequestToReadPaths } from "./lib/api-request-allowlist.mjs";
import { wrapCreateNote } from "./lib/hubspot-notes.mjs";

const API_VERSION = "2026-09";
const OBJECTS = `/crm/objects/${API_VERSION}`;
const CORE_OBJECT_TYPES = ["contacts", "companies", "deals", "tickets"];
const OBJECT_TYPES = [...CORE_OBJECT_TYPES, "notes", "tasks", "calls", "meetings", "emails", "products", "line_items", "quotes", "leads"];
// api_request tool calls may read only these (CRM data and the account's portal id/time zone).
export const TOOL_READ_PATH_PREFIXES = [
  "/crm/objects",
  "/crm/properties",
  "/crm/pipelines",
  "/crm/owners",
  "/crm/associations",
  "/crm/v3/objects",
  "/crm/v3/properties",
  "/crm/v3/pipelines",
  "/crm/v3/owners",
  "/crm/v4/objects",
  "/crm/v4/associations",
  "/account-info/2026-09/details",
  "/account-info/v3/details",
];

const objectType = (types, description = "CRM object type") => ({ in: "path", type: "string", required: true, enum: types, description });
const OBJECT_ID = { in: "path", type: "string", required: true, description: "Record id (hs_object_id), or a unique property value with id_property" };
const propertyList = { in: "query", type: "array", items: { type: "string" }, maxItems: 200, description: "Properties to return, e.g. [email, firstname, lastname] (default: a few basic ones)" };
const associationList = { in: "query", type: "array", items: { type: "string" }, maxItems: 20, description: "Object types to return associated record ids for, e.g. [companies, deals]" };
const idProperty = { in: "query", type: "string", wireName: "idProperty", description: "Unique property that object_id holds instead of the record id, e.g. email" };
const recordProperties = (required) => ({ in: "body", type: "object", required, description: 'Property values by internal name, e.g. {"email": "ada@example.com", "firstname": "Ada"}' });
const afterPage = (maxLimit, defaultLimit) => ({ dataPath: "results", cursorPath: "paging.next.after", cursorParam: "after", limitParam: "limit", maxLimit, defaultLimit });

const recordOperations = [
  {
    name: "list_objects",
    title: "List records",
    description: "A page of records of one object type (oldest first); use search_objects to filter or sort",
    path: `${OBJECTS}/{object_type}`,
    params: {
      object_type: objectType(OBJECT_TYPES),
      properties: propertyList,
      associations: associationList,
      archived: { in: "query", type: "boolean", description: "Only archived (recycle bin) records" },
    },
    response: afterPage(100, 20),
  },
  {
    name: "get_object",
    title: "Get record",
    description: "One record by id, or by a unique property such as email (id_property)",
    path: `${OBJECTS}/{object_type}/{object_id}`,
    params: {
      object_type: objectType(OBJECT_TYPES),
      object_id: OBJECT_ID,
      properties: propertyList,
      properties_with_history: { ...propertyList, wireName: "propertiesWithHistory", description: "Properties to return with their previous values" },
      associations: associationList,
      id_property: idProperty,
      archived: { in: "query", type: "boolean" },
    },
  },
  {
    name: "search_objects",
    title: "Search records",
    description: "Search records with filters (AND within a group, OR across up to 5 groups), a text query and one sort; at most 10,000 results per search",
    method: "POST",
    path: `${OBJECTS}/{object_type}/search`,
    // A search changes nothing, so retrying it is harmless.
    write: "idempotent",
    params: {
      object_type: objectType(OBJECT_TYPES),
      query: { in: "body", type: "string", description: "Text matched against the default searchable properties (e.g. name, email, domain)" },
      filter_groups: {
        in: "body",
        type: "array",
        items: { type: "object" },
        maxItems: 5,
        wireName: "filterGroups",
        description: 'e.g. [{"filters": [{"propertyName": "lifecyclestage", "operator": "EQ", "value": "lead"}]}]; operators EQ, NEQ, LT, LTE, GT, GTE, BETWEEN, IN, NOT_IN, HAS_PROPERTY, NOT_HAS_PROPERTY, CONTAINS_TOKEN, NOT_CONTAINS_TOKEN',
      },
      sorts: { in: "body", type: "array", items: { type: "object" }, maxItems: 1, description: 'One sort, e.g. [{"propertyName": "createdate", "direction": "DESCENDING"}]' },
      properties: { in: "body", type: "array", items: { type: "string" }, maxItems: 200, description: "Properties to return" },
    },
    response: afterPage(200, 20),
  },
  {
    name: "create_object",
    title: "Create record",
    description: "Create a record with property values, optionally associated with other records",
    method: "POST",
    path: `${OBJECTS}/{object_type}`,
    write: "unsafe",
    checkHint: "search_objects for a unique property (e.g. email or name) before creating again",
    params: {
      object_type: objectType(OBJECT_TYPES),
      properties: recordProperties(true),
      associations: {
        in: "body",
        type: "array",
        items: { type: "object" },
        maxItems: 100,
        description: 'e.g. [{"to": {"id": "123"}, "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 279}]}]',
      },
    },
  },
  {
    name: "update_object",
    title: "Update record",
    description: "Change property values of a record (empty string clears a value)",
    method: "PATCH",
    path: `${OBJECTS}/{object_type}/{object_id}`,
    // Setting the same values again gives the same record.
    write: "idempotent",
    params: { object_type: objectType(OBJECT_TYPES), object_id: OBJECT_ID, id_property: idProperty, properties: recordProperties(true) },
  },
  {
    name: "archive_object",
    title: "Archive record",
    description: "Move a record to the recycle bin (restorable for 90 days)",
    method: "DELETE",
    path: `${OBJECTS}/{object_type}/{object_id}`,
    write: "idempotent",
    nodeOnly: true,
    params: { object_type: objectType(OBJECT_TYPES), object_id: { in: "path", type: "string", required: true, description: "Record id" } },
  },
];

const fromRecord = {
  from_object_type: objectType(OBJECT_TYPES, "Object type of the record"),
  from_object_id: { in: "path", type: "string", required: true, description: "Record id" },
};
const toObjectType = objectType(OBJECT_TYPES, "Object type of the associated records");
const associationOperations = [
  {
    name: "list_associations",
    title: "List associations",
    description: "Records of one object type associated with a record, with association labels",
    path: `${OBJECTS}/{from_object_type}/{from_object_id}/associations/{to_object_type}`,
    params: { ...fromRecord, to_object_type: toObjectType },
    response: afterPage(500, 100),
  },
  {
    name: "associate_objects",
    title: "Associate records",
    description: "Create the default (unlabeled) association between two records, e.g. a contact and a company",
    method: "PUT",
    path: `${OBJECTS}/{from_object_type}/{from_object_id}/associations/default/{to_object_type}/{to_object_id}`,
    write: "idempotent",
    params: { ...fromRecord, to_object_type: toObjectType, to_object_id: { in: "path", type: "string", required: true, description: "Record id to associate with" } },
  },
  {
    name: "remove_association",
    title: "Remove association",
    description: "Remove every association between two records (the records stay)",
    method: "DELETE",
    path: `${OBJECTS}/{from_object_type}/{from_object_id}/associations/{to_object_type}/{to_object_id}`,
    write: "idempotent",
    nodeOnly: true,
    params: { ...fromRecord, to_object_type: toObjectType, to_object_id: { in: "path", type: "string", required: true } },
  },
  {
    name: "create_note",
    title: "Add note",
    description: "Add a note to the timeline of contacts, companies, deals or tickets",
    method: "POST",
    path: `${OBJECTS}/notes`,
    write: "unsafe",
    checkHint: "list_associations from the record to notes and look for the text",
    // lib/hubspot-notes.mjs builds these from body/timestamp/owner_id and the *_ids lists.
    params: {
      note_body: { in: "body", type: "string", wireName: "properties.hs_note_body" },
      note_timestamp: { in: "body", type: "string", wireName: "properties.hs_timestamp" },
      owner_id: { in: "body", type: "string", wireName: "properties.hubspot_owner_id" },
      associations: { in: "body", type: "array", items: { type: "object" }, maxItems: 400 },
    },
  },
];

const schemaOperations = [
  {
    name: "list_properties",
    title: "List properties",
    description: "Property definitions of an object type: internal names, labels, types and dropdown options",
    path: `/crm/properties/${API_VERSION}/{object_type}`,
    params: { object_type: objectType(OBJECT_TYPES), archived: { in: "query", type: "boolean" } },
    response: { dataPath: "results" },
  },
  {
    name: "list_pipelines",
    title: "List pipelines",
    description: "Deal or ticket pipelines with their stages (stage ids for dealstage / hs_pipeline_stage)",
    path: `/crm/pipelines/${API_VERSION}/{object_type}`,
    params: { object_type: objectType(["deals", "tickets"], "deals or tickets") },
    response: { dataPath: "results" },
  },
  {
    name: "list_owners",
    title: "List owners",
    description: "Users that records can be assigned to (ids for hubspot_owner_id)",
    path: `/crm/owners/${API_VERSION}`,
    params: { email: { in: "query", type: "string", description: "Only the owner with this email" }, archived: { in: "query", type: "boolean" } },
    response: afterPage(500, 100),
  },
  { name: "get_account_details", title: "Account details", description: "Portal id, time zone, currency and data hosting location of the account", path: `/account-info/${API_VERSION}/details` },
];

export const restDefinition = defineRestPlugin({
  name: "hubspot",
  version: "0.1.0",
  description: "HubSpot CRM (API 2026-09): contacts, companies, deals, tickets and other objects (list, get, search, create, update), associations, notes, properties, pipelines, owners; archiving is node only",
  apiName: "HubSpot API",
  baseUrl: "https://api.hubapi.com",
  toolUserToken: true,
  auth: { type: "bearer", env: "HUBSPOT_ACCESS_TOKEN" },
  // Errors are {status: "error", message, correlationId, category, context?}; 429s carry errorType RATE_LIMIT.
  errors: {
    messagePath: ["message"],
    codePath: "category",
    kindByCode: {
      INVALID_AUTHENTICATION: "auth_error",
      EXPIRED_AUTHENTICATION: "auth_error",
      MISSING_SCOPES: "permission_denied",
      OBJECT_NOT_FOUND: "not_found",
      VALIDATION_ERROR: "invalid_input",
      RATE_LIMITS: "rate_limited",
    },
  },
  apiRequest: { examplePath: `/crm/objects/${API_VERSION}/contacts/<id>/associations/deals` },
  operations: [...recordOperations, ...associationOperations, ...schemaOperations],
});

const wrapApiRequest = (operation) => restrictApiRequestToReadPaths(operation, TOOL_READ_PATH_PREFIXES);
const wrappers = { create_note: wrapCreateNote, api_request: wrapApiRequest };
export const pluginDefinition = { ...restDefinition, operations: restDefinition.operations.map((operation) => wrappers[operation.name]?.(operation) ?? operation) };
