/**
 * mailchimp plugin definition: the Mailchimp Marketing API 3.0 (https://mailchimp.com/developer/marketing/api/).
 * Audiences (lists), members and tags, member search, campaigns and campaign reports. Built with the declarative
 * REST layer (docs/declarative-plugins.md); member operations accept an email instead of the MD5 subscriber hash
 * (lib/subscriber-hash.mjs).
 *
 * The host is per data center (`https://<dc>.api.mailchimp.com/3.0`): the dc is the API key's suffix
 * (`...-us21`), or MAILCHIMP_SERVER_PREFIX (needed for OAuth tokens passed by a node).
 *
 * Agent policy: reads are tools. Adding or updating members and changing their tags (which can start
 * automations that email them) need MAILCHIMP_TOOL_ALLOW_MEMBER_WRITES=1 as tools. Sending, scheduling and
 * unscheduling campaigns, archiving and permanently deleting members are node only. api_request as a tool may only
 * read an allowlist of paths, without webhook configs (lib/api-request-allowlist.mjs).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { wrapMemberOperation } from "./lib/subscriber-hash.mjs";
import { restrictApiRequestToReadPaths } from "./lib/api-request-allowlist.mjs";

// api_request tool calls may read only these; webhook configs (their URLs often carry a secret) are refused even
// under /lists, and paths are decoded and checked for dot segments first (lib/api-request-allowlist.mjs).
export const TOOL_READ_PATH_PREFIXES = ["/ping", "/lists", "/search-members", "/campaigns", "/campaign-folders", "/reports", "/templates", "/template-folders"];
export const TOOL_BLOCKED_PATH_PREFIXES = ["/lists/*/webhooks"];

const API_KEY_ENV = "MAILCHIMP_API_KEY";
const SERVER_PREFIX_ENV = "MAILCHIMP_SERVER_PREFIX";
const MEMBER_WRITE_POLICY = "optIn:MAILCHIMP_TOOL_ALLOW_MEMBER_WRITES";
const DATA_CENTER_PATTERN = /^[a-z]+[0-9]+$/;
const MEMBER_STATUSES = ["subscribed", "unsubscribed", "cleaned", "pending", "transactional"];
const CAMPAIGN_TYPES = ["regular", "plaintext", "absplit", "rss", "variate"];

/**
 * Builds the data center's base URL from MAILCHIMP_SERVER_PREFIX or the API key suffix.
 *
 * @param environment - Environment variables (object)
 * @returns e.g. "https://us21.api.mailchimp.com/3.0" (string)
 * @throws Error - When no valid data center can be found (the layer reports it as invalid_input)
 */
function buildMailchimpBaseUrl(environment) {
  const configuredPrefix = environment[SERVER_PREFIX_ENV]?.trim();
  const apiKey = environment[API_KEY_ENV]?.trim() ?? "";
  const dataCenter = configuredPrefix || (apiKey.includes("-") ? apiKey.slice(apiKey.lastIndexOf("-") + 1) : "");
  if (!DATA_CENTER_PATTERN.test(dataCenter)) {
    throw new Error(`the data center must be the API key's suffix (e.g. ...-us21) or ${SERVER_PREFIX_ENV} (e.g. us21)`);
  }
  return `https://${dataCenter}.api.mailchimp.com/3.0`;
}

const LIST_ID = { in: "path", type: "string", required: true, description: "Audience (list) id, from list_audiences" };
const CAMPAIGN_ID = { in: "path", type: "string", required: true, description: "Campaign id, from list_campaigns" };
const SUBSCRIBER_HASH = { in: "path", type: "string", required: true, description: "MD5 of the lower-cased email; or pass `email` instead" };
const fieldParams = {
  fields: { in: "query", type: "array", items: { type: "string" }, description: "Only these fields (dot notation, e.g. lists.id,lists.name)" },
  exclude_fields: { in: "query", type: "array", items: { type: "string" }, description: "Leave out these fields (not with fields)" },
};
const offsetPage = (dataPath) => ({ dataPath, offsetPagination: { offsetParam: "offset", limitParam: "count", totalPath: "total_items" }, maxLimit: 1000, defaultLimit: 50 });
const memberBody = {
  status: { in: "body", type: "string", enum: MEMBER_STATUSES, description: "New status; subscribed only with the person's consent, pending sends a double opt-in email" },
  merge_fields: { in: "body", type: "object", description: 'Merge field values, e.g. {"FNAME": "Ada", "LNAME": "Lovelace"}' },
  email_type: { in: "body", type: "string", enum: ["html", "text"] },
  language: { in: "body", type: "string", description: "Language code, e.g. en, id" },
  vip: { in: "body", type: "boolean" },
  interests: { in: "body", type: "object", description: "Interest (group) ids to booleans" },
};

const audienceOperations = [
  { name: "ping", title: "Ping", description: "Check the API key and data center (health_status)", path: "/ping" },
  {
    name: "list_audiences",
    title: "List audiences",
    description: "Audiences (lists) with their stats",
    path: "/lists",
    params: {
      ...fieldParams,
      email: { in: "query", type: "string", description: "Only audiences that contain this email" },
      since_date_created: { in: "query", type: "string", description: "ISO 8601, e.g. 2026-01-01T00:00:00+00:00" },
      before_date_created: { in: "query", type: "string", description: "ISO 8601" },
      sort_dir: { in: "query", type: "string", enum: ["ASC", "DESC"], description: "By date_created" },
    },
    response: offsetPage("lists"),
  },
  { name: "get_audience", title: "Get audience", description: "One audience with its settings and stats", path: "/lists/{list_id}", params: { list_id: LIST_ID, ...fieldParams } },
];

const memberOperations = [
  {
    name: "list_members",
    title: "List members",
    description: "Members of an audience, filtered by status or change date",
    path: "/lists/{list_id}/members",
    params: {
      list_id: LIST_ID,
      ...fieldParams,
      status: { in: "query", type: "string", enum: [...MEMBER_STATUSES, "archived"] },
      since_last_changed: { in: "query", type: "string", description: "ISO 8601" },
      before_last_changed: { in: "query", type: "string", description: "ISO 8601" },
      vip_only: { in: "query", type: "boolean" },
      sort_field: { in: "query", type: "string", enum: ["timestamp_opt", "timestamp_signup", "last_changed"] },
      sort_dir: { in: "query", type: "string", enum: ["ASC", "DESC"] },
    },
    response: offsetPage("members"),
  },
  { name: "get_member", title: "Get member", description: "One member by email (or subscriber hash)", path: "/lists/{list_id}/members/{subscriber_hash}", params: { list_id: LIST_ID, subscriber_hash: SUBSCRIBER_HASH, ...fieldParams } },
  {
    name: "search_members",
    title: "Search members",
    description: "Find members by email or first/last name in one audience or all (exact_matches and full_search)",
    path: "/search-members",
    params: { query: { in: "query", type: "string", required: true, minLength: 1, description: "Email address or name" }, list_id: { in: "query", type: "string", description: "Only this audience" }, ...fieldParams },
  },
  {
    name: "upsert_member",
    title: "Add or update member",
    description: "Add a member, or update them if the email is already in the audience (status_if_new applies to new members only)",
    method: "PUT",
    path: "/lists/{list_id}/members/{subscriber_hash}",
    // A PUT of the same document: repeating it leaves the member as it is.
    write: "idempotent",
    toolPolicy: MEMBER_WRITE_POLICY,
    params: {
      list_id: LIST_ID,
      subscriber_hash: SUBSCRIBER_HASH,
      skip_merge_validation: { in: "query", type: "boolean", description: "Accept members without required merge fields" },
      email_address: { in: "body", type: "string", description: "Email; needed when the member is new (the hash is computed from it)" },
      status_if_new: { in: "body", type: "string", enum: MEMBER_STATUSES, description: "Status for a new member; pending sends a double opt-in confirmation" },
      ...memberBody,
      tags: { in: "body", type: "array", items: { type: "string" }, maxItems: 50, description: "Tags for a new member" },
    },
  },
  {
    name: "list_member_tags",
    title: "Member tags",
    description: "Tags of one member",
    path: "/lists/{list_id}/members/{subscriber_hash}/tags",
    params: { list_id: LIST_ID, subscriber_hash: SUBSCRIBER_HASH },
    response: offsetPage("tags"),
  },
  {
    name: "update_member_tags",
    title: "Add or remove member tags",
    description: "Add (status active) or remove (status inactive) tags on a member; tags may start automations unless is_syncing",
    method: "POST",
    path: "/lists/{list_id}/members/{subscriber_hash}/tags",
    // Setting the same tags active/inactive again changes nothing.
    write: "idempotent",
    toolPolicy: MEMBER_WRITE_POLICY,
    params: {
      list_id: LIST_ID,
      subscriber_hash: SUBSCRIBER_HASH,
      tags: { in: "body", type: "array", required: true, maxItems: 100, items: { type: "object" }, description: 'e.g. [{"name": "vip", "status": "active"}]' },
      is_syncing: { in: "body", type: "boolean", description: "true: do not start automations for these tags" },
    },
  },
  {
    name: "archive_member",
    title: "Archive member",
    description: "Archive a member (they can be added back later)",
    method: "DELETE",
    path: "/lists/{list_id}/members/{subscriber_hash}",
    write: "idempotent",
    nodeOnly: true,
    params: { list_id: LIST_ID, subscriber_hash: SUBSCRIBER_HASH },
  },
  {
    name: "delete_member_permanently",
    title: "Delete member permanently",
    description: "Erase a member and their data; they can never be re-imported",
    method: "POST",
    path: "/lists/{list_id}/members/{subscriber_hash}/actions/delete-permanent",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_member (404 means it was deleted)",
    params: { list_id: LIST_ID, subscriber_hash: SUBSCRIBER_HASH },
  },
];

const campaignOperations = [
  {
    name: "list_campaigns",
    title: "List campaigns",
    description: "Campaigns, filtered by type, status, audience or send/create time",
    path: "/campaigns",
    params: {
      ...fieldParams,
      campaign_type: { in: "query", type: "string", enum: CAMPAIGN_TYPES, wireName: "type" },
      status: { in: "query", type: "string", enum: ["save", "paused", "schedule", "sending", "sent"] },
      list_id: { in: "query", type: "string", description: "Only campaigns for this audience" },
      since_send_time: { in: "query", type: "string", description: "ISO 8601" },
      before_send_time: { in: "query", type: "string", description: "ISO 8601" },
      since_create_time: { in: "query", type: "string", description: "ISO 8601" },
      before_create_time: { in: "query", type: "string", description: "ISO 8601" },
      sort_field: { in: "query", type: "string", enum: ["create_time", "send_time"] },
      sort_dir: { in: "query", type: "string", enum: ["ASC", "DESC"] },
    },
    response: offsetPage("campaigns"),
  },
  { name: "get_campaign", title: "Get campaign", description: "One campaign: settings, recipients, status and send time", path: "/campaigns/{campaign_id}", params: { campaign_id: CAMPAIGN_ID, ...fieldParams } },
  { name: "get_campaign_content", title: "Campaign content", description: "A campaign's HTML and plain-text content", path: "/campaigns/{campaign_id}/content", params: { campaign_id: CAMPAIGN_ID, ...fieldParams } },
  {
    name: "send_campaign",
    title: "Send campaign",
    description: "Send a campaign to its whole audience now",
    method: "POST",
    path: "/campaigns/{campaign_id}/actions/send",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_campaign and look at status (sending or sent)",
    params: { campaign_id: CAMPAIGN_ID },
  },
  {
    name: "schedule_campaign",
    title: "Schedule campaign",
    description: "Schedule a campaign to send at a quarter-hour UTC time",
    method: "POST",
    path: "/campaigns/{campaign_id}/actions/schedule",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_campaign and look at status (schedule) and send_time",
    params: {
      campaign_id: CAMPAIGN_ID,
      schedule_time: { in: "body", type: "string", required: true, description: "UTC ISO 8601 on :00, :15, :30 or :45, e.g. 2026-12-01T09:30:00Z" },
      timewarp: { in: "body", type: "boolean", description: "Deliver at schedule_time in each recipient's time zone (not with batches)" },
      batch_count: { in: "body", type: "integer", min: 1, wireName: "batch_delivery.batch_count" },
      batch_delay: { in: "body", type: "integer", min: 1, wireName: "batch_delivery.batch_delay", description: "Minutes between batches" },
    },
  },
  {
    name: "unschedule_campaign",
    title: "Unschedule campaign",
    description: "Return a scheduled campaign to draft",
    method: "POST",
    path: "/campaigns/{campaign_id}/actions/unschedule",
    write: "idempotent",
    nodeOnly: true,
    params: { campaign_id: CAMPAIGN_ID },
  },
];

const reportOperations = [
  {
    name: "list_reports",
    title: "List campaign reports",
    description: "Reports of sent campaigns: opens, clicks, bounces, unsubscribes",
    path: "/reports",
    params: {
      ...fieldParams,
      campaign_type: { in: "query", type: "string", enum: CAMPAIGN_TYPES, wireName: "type" },
      since_send_time: { in: "query", type: "string", description: "ISO 8601" },
      before_send_time: { in: "query", type: "string", description: "ISO 8601" },
    },
    response: offsetPage("reports"),
  },
  { name: "get_report", title: "Campaign report", description: "Report of one sent campaign", path: "/reports/{campaign_id}", params: { campaign_id: CAMPAIGN_ID, ...fieldParams } },
];

// Webhook URLs often carry a shared secret (Mailchimp webhooks are unsigned), so these reads are node only; that
// also keeps the agent's GET-only api_request away from them.
const webhookOperations = [
  { name: "list_audience_webhooks", title: "Audience webhooks", description: "Webhooks of an audience (URLs may hold secrets)", path: "/lists/{list_id}/webhooks", nodeOnly: true, params: { list_id: LIST_ID } },
  {
    name: "get_audience_webhook",
    title: "Get audience webhook",
    description: "One audience webhook",
    path: "/lists/{list_id}/webhooks/{webhook_id}",
    nodeOnly: true,
    params: { list_id: LIST_ID, webhook_id: { in: "path", type: "string", required: true } },
  },
  { name: "list_batch_webhooks", title: "Batch webhooks", description: "Batch operation webhooks", path: "/batch-webhooks", nodeOnly: true, response: offsetPage("webhooks") },
];

export const restDefinition = defineRestPlugin({
  name: "mailchimp",
  version: "0.1.0",
  description: "Mailchimp Marketing API: audiences, members and tags (by email), member search, campaigns and reports; campaign sends and deletes are node only",
  apiName: "Mailchimp Marketing API",
  baseUrl: buildMailchimpBaseUrl,
  allowedHostSuffix: ".api.mailchimp.com",
  // HTTP Basic with any user name and the API key as the password.
  auth: { type: "basic", tokenEnv: API_KEY_ENV, user: "graphrt" },
  extraEnv: [SERVER_PREFIX_ENV],
  // Errors are application/problem+json: {type, title, status, detail, instance, errors?}.
  errors: {
    messagePath: ["detail", "title"],
    codePath: "title",
    kindByCode: {
      "API Key Invalid": "auth_error",
      "Resource Not Found": "not_found",
      Forbidden: "permission_denied",
      "User Disabled": "permission_denied",
      "Authorization Failure": "permission_denied",
      "Invalid Resource": "invalid_input",
      "Member Exists": "invalid_input",
      "Bad Request": "invalid_input",
      "JSON Parse Exception": "invalid_input",
      TooManyRequests: "rate_limited",
    },
  },
  apiRequest: { examplePath: "/lists/<list_id>/merge-fields" },
  operations: [...audienceOperations, ...memberOperations, ...campaignOperations, ...reportOperations, ...webhookOperations],
});

const MEMBER_OPERATION_NAMES = new Set(["get_member", "upsert_member", "list_member_tags", "update_member_tags", "archive_member", "delete_member_permanently"]);
const guardApiRequest = (operation) => restrictApiRequestToReadPaths(operation, TOOL_READ_PATH_PREFIXES, TOOL_BLOCKED_PATH_PREFIXES);

/**
 * Applies the plugin's wrappers: email-to-hash on member operations and (unless turned off for the contract suite,
 * whose api_request probe uses an arbitrary path) the api_request tool path allowlist.
 *
 * @param definition - Definition from defineRestPlugin (object)
 * @param options - `{guardApiRequestPaths}` (object)
 * @returns Wrapped definition (object)
 */
export function wrapMailchimpDefinition(definition, { guardApiRequestPaths = true } = {}) {
  const wrapOperation = (operation) => {
    if (MEMBER_OPERATION_NAMES.has(operation.name)) return wrapMemberOperation(operation);
    if (guardApiRequestPaths && operation.name === "api_request") return guardApiRequest(operation);
    return operation;
  };
  return { ...definition, operations: definition.operations.map(wrapOperation) };
}

export const pluginDefinition = wrapMailchimpDefinition(restDefinition);
