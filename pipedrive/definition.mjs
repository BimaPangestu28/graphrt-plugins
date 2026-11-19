/**
 * pipedrive plugin definition: the Pipedrive CRM API (https://developers.pipedrive.com/docs/api/v1) with an API
 * token in the `x-api-token` header. Persons, organizations, deals and activities use API v2 (cursor pagination,
 * PATCH updates, search endpoints); notes, the current user and anything without a v2 endpoint use API v1. Built
 * with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Agent policy: reads, creates and updates are tools; deletes are node only. Agent `api_request` calls only reach
 * CRM read paths (lib/tool-path-policy.mjs), because other GET endpoints return webhook basic-auth passwords and
 * connected-account details.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";

export const COMPANY_DOMAIN_ENV = "PIPEDRIVE_COMPANY_DOMAIN";
export const TOOL_API_EXTRA_PATHS_ENV = "PIPEDRIVE_TOOL_API_EXTRA_PATHS";
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The API base for PIPEDRIVE_COMPANY_DOMAIN (`acme` or `acme.pipedrive.com`), or api.pipedrive.com when unset.
 *
 * @param environment - Environment variables (object)
 * @returns Base URL ending in /api; operation paths start with /v1 or /v2 (string)
 * @throws Error - When the value is not a Pipedrive subdomain (becomes invalid_input)
 */
export function buildPipedriveBaseUrl(environment) {
  const configured = environment?.[COMPANY_DOMAIN_ENV]?.trim().toLowerCase().replace(/\.pipedrive\.com$/, "");
  if (!configured) return "https://api.pipedrive.com/api";
  if (!SUBDOMAIN_PATTERN.test(configured)) throw new Error(`${COMPANY_DOMAIN_ENV} must be your Pipedrive subdomain, e.g. acme (for acme.pipedrive.com)`);
  return `https://${configured}.pipedrive.com/api`;
}

// --- shared parameter shapes -------------------------------------------------------------------------

const idPath = (label) => ({ in: "path", type: "integer", required: true, min: 1, description: `${label} id` });
const integerQuery = (description) => ({ in: "query", type: "integer", min: 1, description });
const integerBody = (description) => ({ in: "body", type: "integer", min: 1, description });
const v2Page = (maxLimit) => ({ dataPath: "data", cursorPath: "additional_data.next_cursor", cursorParam: "cursor", limitParam: "limit", maxLimit, defaultLimit: 100 });
const RECORD = { dataPath: "data" };
const searchPage = { ...v2Page(100), dataPath: "data.items" };
const listFilters = {
  filter_id: integerQuery("Saved filter id; overrides the other filters"),
  ids: { in: "query", type: "array", items: { type: "integer" }, maxItems: 100, description: "Only these ids (up to 100)" },
  owner_id: integerQuery("Only records owned by this user"),
  updated_since: { in: "query", type: "string", description: "RFC 3339 time, e.g. 2026-01-01T00:00:00Z" },
  updated_until: { in: "query", type: "string", description: "RFC 3339 time" },
  sort_by: { in: "query", type: "string", enum: ["id", "update_time", "add_time"], description: "Default id" },
  sort_direction: { in: "query", type: "string", enum: ["asc", "desc"], description: "Default asc" },
  custom_fields: { in: "query", type: "array", items: { type: "string" }, maxItems: 15, description: "Custom field keys to return (max 15)" },
};
const includeFields = (examples) => ({ in: "query", type: "array", items: { type: "string" }, description: `Extra fields, e.g. ${examples}` });
const searchParams = (fieldNames) => ({
  term: { in: "query", type: "string", required: true, minLength: 1, description: "Search text (at least 2 characters, or 1 with exact_match)" },
  fields: { in: "query", type: "array", items: { type: "string", enum: fieldNames }, description: `Fields to search: ${fieldNames.join(", ")}` },
  exact_match: { in: "query", type: "boolean", description: "Only full, case-insensitive matches" },
});
const ownershipBody = {
  owner_id: integerBody("Owner user id (default: the token's user)"),
  visible_to: { in: "body", type: "integer", enum: [1, 3, 5, 7], description: "Visibility: 1 owner only, 3 owner's group, 5 group and sub-groups, 7 whole company" },
  label_ids: { in: "body", type: "array", items: { type: "integer" }, description: "Label ids" },
  custom_fields: { in: "body", type: "object", description: "Custom field values keyed by field key (40-char hash); null clears a value" },
};
const contactDetails = (kind) => ({
  in: "body",
  type: "array",
  items: { type: "object" },
  maxItems: 50,
  description: `${kind}, e.g. [{"value": "...", "primary": true, "label": "work"}]`,
});
const addressBody = { in: "body", type: "object", description: 'Address object, e.g. {"value": "Jl. Sudirman 1, Jakarta"} (or country, locality, postal_code, ...)' };

/**
 * Builds the v2 list/get/create/update/delete operations of one record type.
 *
 * @param resource - `{plural, singular, label, path, listParams, getParams, createParams, updateParams, checkHint}` (object)
 * @returns Operations (object[])
 */
function buildRecordOperations({ plural, singular, label, path, listParams, getParams = {}, createParams, updateParams, checkHint }) {
  const recordId = { [`${singular}_id`]: idPath(label) };
  const recordPath = `${path}/{${singular}_id}`;
  return [
    { name: `list_${plural}`, title: `List ${plural}`, description: `${label}s, filtered and sorted, with cursor pagination`, path, params: listParams, response: v2Page(500) },
    { name: `get_${singular}`, title: `Get ${singular}`, description: `One ${label.toLowerCase()} by id`, path: recordPath, params: { ...recordId, ...getParams }, response: RECORD },
    { name: `create_${singular}`, title: `Create ${singular}`, description: `Create a ${label.toLowerCase()}`, method: "POST", path, write: "unsafe", checkHint, params: createParams, response: RECORD },
    // PATCH with the same fields gives the same record, so a retry is harmless.
    { name: `update_${singular}`, title: `Update ${singular}`, description: `Change fields of a ${label.toLowerCase()} (only the given fields)`, method: "PATCH", path: recordPath, write: "idempotent", params: { ...recordId, ...updateParams }, response: RECORD },
    {
      name: `delete_${singular}`,
      title: `Delete ${singular}`,
      description: `Mark a ${label.toLowerCase()} deleted (removed for good after 30 days)`,
      method: "DELETE",
      path: recordPath,
      write: "idempotent",
      nodeOnly: true,
      params: recordId,
    },
  ];
}

const searchOperation = (plural, label, path, params, include) => ({
  name: `search_${plural}`,
  title: `Search ${plural}`,
  description: `Find ${label.toLowerCase()}s by text; each item is {result_score, item}`,
  path: `${path}/search`,
  params: include ? { ...params, include_fields: include } : params,
  response: searchPage,
});

// --- persons, organizations, deals, activities (API v2) ------------------------------------------------

const personFields = {
  emails: contactDetails("Email addresses"),
  phones: contactDetails("Phone numbers"),
  org_id: integerBody("Organization id"),
  ...ownershipBody,
};
const personOperations = [
  ...buildRecordOperations({
    plural: "persons",
    singular: "person",
    label: "Person",
    path: "/v2/persons",
    listParams: { ...listFilters, org_id: integerQuery("Only persons of this organization"), deal_id: integerQuery("Only persons linked to this deal"), include_fields: includeFields("open_deals_count, next_activity_id, marketing_status") },
    createParams: { name: { in: "body", type: "string", required: true, minLength: 1, description: "Full name" }, ...personFields },
    updateParams: { name: { in: "body", type: "string", minLength: 1 }, ...personFields },
    checkHint: "search_persons for the name or email",
  }),
  searchOperation("persons", "Person", "/v2/persons", { ...searchParams(["custom_fields", "email", "notes", "phone", "name"]), organization_id: integerQuery("Only persons of this organization") }, includeFields("person.picture")),
];

const organizationFields = {
  address: addressBody,
  website: { in: "body", type: "string" },
  industry: { in: "body", type: "integer", description: "Industry option id (an integer, see the organization fields)" },
  ...ownershipBody,
};
const organizationOperations = [
  ...buildRecordOperations({
    plural: "organizations",
    singular: "organization",
    label: "Organization",
    path: "/v2/organizations",
    listParams: { ...listFilters, include_fields: includeFields("open_deals_count, people_count, next_activity_id") },
    createParams: { name: { in: "body", type: "string", required: true, minLength: 1 }, ...organizationFields },
    updateParams: { name: { in: "body", type: "string", minLength: 1 }, ...organizationFields },
    checkHint: "search_organizations for the name",
  }),
  searchOperation("organizations", "Organization", "/v2/organizations", searchParams(["address", "custom_fields", "notes", "name"])),
];

const dealFields = {
  value: { in: "body", type: "number", min: 0, description: "Deal value" },
  currency: { in: "body", type: "string", description: "ISO 4217 code, e.g. IDR (default: the company currency)" },
  person_id: integerBody("Contact person id"),
  org_id: integerBody("Organization id"),
  pipeline_id: integerBody("Pipeline id (list_pipelines)"),
  stage_id: integerBody("Stage id (list_stages)"),
  status: { in: "body", type: "string", enum: ["open", "won", "lost"] },
  expected_close_date: { in: "body", type: "string", description: "YYYY-MM-DD" },
  probability: { in: "body", type: "number", min: 0, max: 100, description: "Success probability in percent" },
  lost_reason: { in: "body", type: "string", description: "Only with status lost" },
  ...ownershipBody,
};
const dealOperations = [
  ...buildRecordOperations({
    plural: "deals",
    singular: "deal",
    label: "Deal",
    path: "/v2/deals",
    listParams: {
      ...listFilters,
      person_id: integerQuery("Only deals of this person"),
      org_id: integerQuery("Only deals of this organization"),
      pipeline_id: integerQuery("Only deals in this pipeline"),
      stage_id: integerQuery("Only deals in this stage"),
      status: { in: "query", type: "string", enum: ["open", "won", "lost", "deleted"], description: "Default: all but deleted" },
      include_fields: includeFields("products_count, next_activity_id, last_incoming_mail_time"),
    },
    createParams: { deal_title: { in: "body", type: "string", required: true, minLength: 1, wireName: "title", description: "Deal title" }, ...dealFields },
    updateParams: { deal_title: { in: "body", type: "string", minLength: 1, wireName: "title", description: "Deal title" }, ...dealFields },
    checkHint: "search_deals for the title",
  }),
  searchOperation(
    "deals",
    "Deal",
    "/v2/deals",
    {
      ...searchParams(["custom_fields", "notes", "title"]),
      person_id: integerQuery("Only deals of this person"),
      organization_id: integerQuery("Only deals of this organization"),
      status: { in: "query", type: "string", enum: ["open", "won", "lost"] },
    },
    includeFields("deal.cc_email"),
  ),
];

// Attendees (calendar invitees by email) are left out: the calendar sync can send them invitations.
const activityFields = {
  subject: { in: "body", type: "string", description: "Activity subject" },
  activity_type: { in: "body", type: "string", wireName: "type", description: "Activity type key, e.g. call, meeting, task, deadline, email, lunch" },
  deal_id: integerBody("Deal id"),
  lead_id: { in: "body", type: "string", description: "Lead id (UUID)" },
  org_id: integerBody("Organization id"),
  participants: { in: "body", type: "array", items: { type: "object" }, maxItems: 50, description: 'Linked persons, e.g. [{"person_id": 5, "primary": true}]' },
  due_date: { in: "body", type: "string", description: "YYYY-MM-DD" },
  due_time: { in: "body", type: "string", description: "HH:MM (UTC)" },
  duration: { in: "body", type: "string", description: "HH:MM" },
  busy: { in: "body", type: "boolean" },
  done: { in: "body", type: "boolean" },
  note: { in: "body", type: "string", description: "Note (HTML allowed)" },
  public_description: { in: "body", type: "string" },
  priority: { in: "body", type: "integer" },
  owner_id: integerBody("Owner user id"),
};
const activityOperations = buildRecordOperations({
  plural: "activities",
  singular: "activity",
  label: "Activity",
  path: "/v2/activities",
  listParams: {
    ...listFilters,
    deal_id: integerQuery("Only activities of this deal"),
    lead_id: { in: "query", type: "string", description: "Only activities of this lead" },
    person_id: integerQuery("Only activities whose primary participant is this person"),
    org_id: integerQuery("Only activities of this organization"),
    done: { in: "query", type: "boolean", description: "true: done only, false: open only" },
    sort_by: { in: "query", type: "string", enum: ["id", "update_time", "add_time", "due_date"], description: "Default id" },
    include_fields: includeFields("attendees"),
  },
  getParams: { include_fields: includeFields("attendees") },
  createParams: activityFields,
  updateParams: activityFields,
  checkHint: "list_activities for the deal or person and look for the subject",
});

// --- pipelines, stages, notes, user ---------------------------------------------------------------------

const pipelineOperations = [
  {
    name: "list_pipelines",
    title: "List pipelines",
    description: "Sales pipelines (ids for deals)",
    path: "/v2/pipelines",
    params: { sort_by: { in: "query", type: "string", enum: ["id", "update_time", "add_time"] }, sort_direction: listFilters.sort_direction },
    response: v2Page(500),
  },
  {
    name: "list_stages",
    title: "List stages",
    description: "Pipeline stages in order (ids for deals)",
    path: "/v2/stages",
    params: { pipeline_id: integerQuery("Only stages of this pipeline"), sort_by: { in: "query", type: "string", enum: ["id", "update_time", "add_time", "order_nr"] }, sort_direction: listFilters.sort_direction },
    response: v2Page(500),
  },
];

const noteLinks = {
  deal_id: integerBody("Deal id"),
  person_id: integerBody("Person id"),
  org_id: integerBody("Organization id"),
  lead_id: { in: "body", type: "string", description: "Lead id (UUID)" },
};
const notePinFlags = {
  pinned_to_deal_flag: { in: "body", type: "integer", enum: [0, 1], description: "1 pins the note to the deal" },
  pinned_to_person_flag: { in: "body", type: "integer", enum: [0, 1], description: "1 pins the note to the person" },
  pinned_to_organization_flag: { in: "body", type: "integer", enum: [0, 1], description: "1 pins the note to the organization" },
};
const noteId = { note_id: idPath("Note") };
const noteOperations = [
  {
    name: "list_notes",
    title: "List notes",
    description: "Notes, optionally of one deal, person, organization or lead (API v1, offset pagination)",
    path: "/v1/notes",
    params: {
      deal_id: integerQuery("Only notes of this deal"),
      person_id: integerQuery("Only notes of this person"),
      org_id: integerQuery("Only notes of this organization"),
      lead_id: { in: "query", type: "string", description: "Only notes of this lead" },
      user_id: integerQuery("Only notes by this user"),
      sort: { in: "query", type: "string", description: "e.g. add_time DESC" },
      start_date: { in: "query", type: "string", description: "YYYY-MM-DD" },
      end_date: { in: "query", type: "string", description: "YYYY-MM-DD" },
      updated_since: { in: "query", type: "string", description: "RFC 3339 time" },
    },
    response: { dataPath: "data", offsetPagination: { offsetParam: "start", limitParam: "limit" }, maxLimit: 500, defaultLimit: 100 },
  },
  { name: "get_note", title: "Get note", description: "One note by id", path: "/v1/notes/{note_id}", params: noteId, response: RECORD },
  {
    name: "create_note",
    title: "Add note",
    description: "Add a note to a deal, person, organization or lead (at least one link is needed)",
    method: "POST",
    path: "/v1/notes",
    write: "unsafe",
    checkHint: "list_notes for the linked record",
    params: { content: { in: "body", type: "string", required: true, minLength: 1, description: "Note text (HTML allowed)" }, ...noteLinks, ...notePinFlags },
    response: RECORD,
  },
  {
    name: "update_note",
    title: "Update note",
    description: "Change a note's text, links or pins",
    method: "PUT",
    path: "/v1/notes/{note_id}",
    write: "idempotent",
    params: { ...noteId, content: { in: "body", type: "string", minLength: 1 }, ...noteLinks, ...notePinFlags },
    response: RECORD,
  },
  { name: "delete_note", title: "Delete note", description: "Delete a note", method: "DELETE", path: "/v1/notes/{note_id}", write: "idempotent", nodeOnly: true, params: noteId },
  { name: "get_current_user", title: "Current user", description: "The token's user and company (ids for owner_id, company_domain)", path: "/v1/users/me", response: RECORD },
];

// --- plugin --------------------------------------------------------------------------------------------

// Agent api_request only reaches CRM data and metadata reads. Left out on purpose: webhooks (their basic-auth
// passwords), userConnections and userSettings, oauth, billing and any other path.
const TOOL_API_RESOURCES = [
  "persons", "organizations", "deals", "activities", "notes", "leads", "products", "pipelines", "stages", "filters",
  "itemsearch", "activitytypes", "currencies", "personfields", "organizationfields", "dealfields", "activityfields",
  "notefields", "productfields", "leadlabels", "leadsources", "users", "projects", "files", "recents",
];
export const TOOL_API_PATHS = [new RegExp(`^/v[12]/(${TOOL_API_RESOURCES.join("|")})(/[^/]+)*$`)];

export const restDefinition = defineRestPlugin({
  name: "pipedrive",
  version: "0.1.0",
  description: "Pipedrive CRM (API v2/v1, API token): persons, organizations, deals and activities (list, get, search, create, update), pipelines, stages and notes; deletes are node only",
  apiName: "Pipedrive API",
  baseUrl: buildPipedriveBaseUrl,
  allowedHostSuffix: ".pipedrive.com",
  auth: { type: "header", header: "x-api-token", env: "PIPEDRIVE_API_TOKEN" },
  extraEnv: [COMPANY_DOMAIN_ENV, TOOL_API_EXTRA_PATHS_ENV],
  // Errors (v1 and v2): {"success": false, "error": "unauthorized access", "errorCode": 401, "error_info": "..."}.
  errors: { messagePath: ["error", "error_info"] },
  apiRequest: { examplePath: "/v1/dealFields" },
  operations: [...personOperations, ...organizationOperations, ...dealOperations, ...activityOperations, ...pipelineOperations, ...noteOperations],
});

export const pluginDefinition = guardToolApiRequest(restDefinition, {
  allowedPaths: TOOL_API_PATHS,
  extraAllowedPathsEnv: TOOL_API_EXTRA_PATHS_ENV,
  reason: `agent tools may only read CRM records and their fields (not webhooks, connections or settings); add paths to ${TOOL_API_EXTRA_PATHS_ENV} or use a workflow node`,
});
