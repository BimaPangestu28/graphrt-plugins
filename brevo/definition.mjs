/**
 * brevo plugin definition: the Brevo API v3 (https://developers.brevo.com/reference): contacts and lists,
 * transactional email (send, templates, events) and email campaigns. Built with the declarative REST layer
 * (docs/declarative-plugins.md); the transactional send checks its recipients (lib/transactional-email.mjs).
 *
 * Agent policy: reads are tools. Transactional sends need BREVO_TOOL_ALLOW_SEND=1 as tools, and
 * BREVO_TOOL_RECIPIENT_ALLOWLIST further limits tool recipients. Creating and updating contacts and adding them
 * to lists (which can start automations that email them) need BREVO_TOOL_ALLOW_CONTACT_WRITES=1. Deleting
 * contacts, sending campaigns and webhook reads (their configs can hold credentials) are node only. api_request as
 * a tool may only read an allowlist of paths (lib/api-request-allowlist.mjs): no webhooks and no sent email content.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { RECIPIENT_ALLOWLIST_ENV, SEND_OPT_IN_ENV, wrapTransactionalSend } from "./lib/transactional-email.mjs";
import { replaceOperation } from "./lib/recipient-policy.mjs";
import { restrictApiRequestToReadPaths } from "./lib/api-request-allowlist.mjs";

// api_request tool calls may read only these. Not /webhooks (credentials) and not /smtp/emails (sent email
// content with reset links and codes); nodes are not limited.
export const TOOL_READ_PATH_PREFIXES = ["/account", "/contacts", "/senders", "/domains", "/smtp/templates", "/smtp/statistics", "/smtp/blockedContacts", "/emailCampaigns"];

const CONTACT_WRITE_POLICY = "optIn:BREVO_TOOL_ALLOW_CONTACT_WRITES";
const IDENTIFIER_TYPES = ["email_id", "contact_id", "ext_id", "phone_id", "whatsapp_id", "landline_number_id"];
const CONTACT_IDENTIFIER = { in: "path", type: "string", required: true, description: "Email, contact id, SMS number or EXT_ID (see identifier_type)" };
const IDENTIFIER_TYPE = { in: "query", type: "string", enum: IDENTIFIER_TYPES, wireName: "identifierType", description: "How to read identifier (needed for ext_id, whatsapp_id, landline_number_id)" };
const LIST_ID = { in: "path", type: "integer", required: true, min: 1, description: "List id, from list_lists" };
const CAMPAIGN_ID = { in: "path", type: "integer", required: true, min: 1, description: "Email campaign id" };
const SORT = { in: "query", type: "string", enum: ["asc", "desc"], description: "By creation date (default desc)" };
const offsetPage = (dataPath, maxLimit, defaultLimit = 50, totalPath) => ({
  dataPath,
  offsetPagination: { offsetParam: "offset", limitParam: "limit", ...(totalPath ? { totalPath } : {}) },
  maxLimit,
  defaultLimit,
});
const recipientList = (description) => ({ in: "body", type: "array", items: { type: "object" }, maxItems: 99, description });
const contactFields = {
  attributes: { in: "body", type: "object", description: 'Existing attributes in upper case, e.g. {"FIRSTNAME": "Ada", "SMS": "+62812..."}' },
  ext_id: { in: "body", type: "string", description: "Your own id for the contact" },
  email_blacklisted: { in: "body", type: "boolean", wireName: "emailBlacklisted", description: "Block (true) or unblock (false) email" },
  sms_blacklisted: { in: "body", type: "boolean", wireName: "smsBlacklisted" },
  list_ids: { in: "body", type: "array", items: { type: "integer" }, wireName: "listIds", description: "Lists to add the contact to" },
};

const accountAndContactReads = [
  { name: "get_account", title: "Account", description: "Account, plan and remaining credits", path: "/account" },
  {
    name: "list_contacts",
    title: "List contacts",
    description: "Contacts, newest first, filtered by list, segment, change date or an attribute",
    path: "/contacts",
    params: {
      modified_since: { in: "query", type: "string", wireName: "modifiedSince", description: "UTC date-time, e.g. 2026-01-01T00:00:00.000Z" },
      created_since: { in: "query", type: "string", wireName: "createdSince" },
      list_ids: { in: "query", type: "array", items: { type: "integer" }, wireName: "listIds", description: "Only contacts in these lists (not with segment_id)" },
      segment_id: { in: "query", type: "integer", min: 1, wireName: "segmentId" },
      filter: { in: "query", type: "string", description: 'Attribute filter, equals only, e.g. equals(FIRSTNAME,"Ada")' },
      sort: SORT,
    },
    response: offsetPage("contacts", 1000),
  },
  {
    name: "get_contact",
    title: "Get contact",
    description: "One contact with attributes, lists and campaign statistics (last 90 days unless dates are given)",
    path: "/contacts/{identifier}",
    params: {
      identifier: CONTACT_IDENTIFIER,
      identifier_type: IDENTIFIER_TYPE,
      start_date: { in: "query", type: "string", wireName: "startDate", description: "YYYY-MM-DD, with end_date" },
      end_date: { in: "query", type: "string", wireName: "endDate", description: "YYYY-MM-DD, with start_date" },
    },
  },
];

const contactWrites = [
  {
    name: "create_contact",
    title: "Create contact",
    description: "Create a contact (email, ext_id or SMS attribute), optionally in lists; update_enabled updates an existing one",
    method: "POST",
    path: "/contacts",
    write: "unsafe",
    toolPolicy: CONTACT_WRITE_POLICY,
    checkHint: "get_contact with the email",
    params: { email: { in: "body", type: "string" }, ...contactFields, update_enabled: { in: "body", type: "boolean", wireName: "updateEnabled", description: "Update the contact if it exists" } },
  },
  {
    name: "update_contact",
    title: "Update contact",
    description: "Update a contact's attributes, blocklist flags and lists",
    method: "PUT",
    path: "/contacts/{identifier}",
    // Setting the same attributes and lists again changes nothing.
    write: "idempotent",
    toolPolicy: CONTACT_WRITE_POLICY,
    params: {
      identifier: CONTACT_IDENTIFIER,
      identifier_type: IDENTIFIER_TYPE,
      ...contactFields,
      unlink_list_ids: { in: "body", type: "array", items: { type: "integer" }, wireName: "unlinkListIds", description: "Lists to remove the contact from" },
    },
  },
  {
    name: "delete_contact",
    title: "Delete contact",
    description: "Delete a contact permanently",
    method: "DELETE",
    path: "/contacts/{identifier}",
    write: "idempotent",
    nodeOnly: true,
    params: { identifier: CONTACT_IDENTIFIER, identifier_type: IDENTIFIER_TYPE },
  },
];

const listOperations = [
  { name: "list_lists", title: "List contact lists", description: "Contact lists with subscriber counts", path: "/contacts/lists", params: { sort: SORT }, response: offsetPage("lists", 50, 10, "count") },
  {
    name: "get_list",
    title: "Get list",
    description: "One list's details and campaign statistics",
    path: "/contacts/lists/{list_id}",
    params: { list_id: LIST_ID, start_date: { in: "query", type: "string", wireName: "startDate" }, end_date: { in: "query", type: "string", wireName: "endDate" } },
  },
  {
    name: "list_list_contacts",
    title: "Contacts in a list",
    description: "Contacts of one list",
    path: "/contacts/lists/{list_id}/contacts",
    params: { list_id: LIST_ID, modified_since: { in: "query", type: "string", wireName: "modifiedSince" }, sort: SORT },
    response: offsetPage("contacts", 500),
  },
  {
    name: "add_contacts_to_list",
    title: "Add contacts to list",
    description: "Add existing contacts to a list by email, contact id or EXT_ID (one kind per call); returns success and failure",
    method: "POST",
    path: "/contacts/lists/{list_id}/contacts/add",
    // Adding a contact that is already in the list changes nothing.
    write: "idempotent",
    toolPolicy: CONTACT_WRITE_POLICY,
    params: {
      list_id: LIST_ID,
      emails: { in: "body", type: "array", items: { type: "string" }, maxItems: 150 },
      ids: { in: "body", type: "array", items: { type: "integer" }, maxItems: 150 },
      ext_ids: { in: "body", type: "array", items: { type: "string" }, maxItems: 150, wireName: "extIds" },
    },
  },
];

const transactionalOperations = [
  {
    name: "send_transactional_email",
    title: "Send transactional email",
    description: "Send one email (HTML/text or a template with params) to up to 99 recipients per field",
    method: "POST",
    path: "/smtp/email",
    write: "unsafe",
    toolPolicy: `optIn:${SEND_OPT_IN_ENV}`,
    checkHint: "list_email_events with the recipient's email (event requests) or the messageId",
    params: {
      sender_email: { in: "body", type: "string", wireName: "sender.email", description: "Verified sender address (or sender_id; templates have their own)" },
      sender_name: { in: "body", type: "string", wireName: "sender.name" },
      sender_id: { in: "body", type: "integer", wireName: "sender.id" },
      to: { ...recipientList('Recipients, e.g. [{"email": "ada@example.com", "name": "Ada"}]'), required: true },
      cc: recipientList("Cc recipients [{email, name?}]"),
      bcc: recipientList("Bcc recipients [{email, name?}]"),
      reply_to_email: { in: "body", type: "string", wireName: "replyTo.email" },
      reply_to_name: { in: "body", type: "string", wireName: "replyTo.name" },
      subject: { in: "body", type: "string", description: "Required without template_id" },
      html_content: { in: "body", type: "string", wireName: "htmlContent", description: "Required without template_id" },
      text_content: { in: "body", type: "string", wireName: "textContent" },
      template_id: { in: "body", type: "integer", min: 1, wireName: "templateId" },
      params: { in: "body", type: "object", description: "Template variables, e.g. {\"ORDER\": \"A-12\"}" },
      tags: { in: "body", type: "array", items: { type: "string" } },
      attachments: { in: "body", type: "array", items: { type: "object" }, maxItems: 20, wireName: "attachment", description: "[{url}] or [{content (base64), name}]" },
      email_headers: { in: "body", type: "object", wireName: "headers", description: "Custom headers in Title-Case" },
      scheduled_at: { in: "body", type: "string", wireName: "scheduledAt", description: "Send later, UTC e.g. 2026-12-01T09:00:00.000Z" },
    },
  },
  {
    name: "list_email_templates",
    title: "Transactional templates",
    description: "Transactional email templates (ids for template_id)",
    path: "/smtp/templates",
    params: { template_status: { in: "query", type: "boolean", wireName: "templateStatus", description: "true active, false inactive" }, sort: SORT },
    response: offsetPage("templates", 1000),
  },
  {
    name: "list_email_events",
    title: "Transactional email events",
    description: "Delivery events of transactional emails (requests, delivered, opened, bounces, ...) in the last days (max 90)",
    path: "/smtp/statistics/events",
    params: {
      email: { in: "query", type: "string", description: "Only this recipient" },
      event: {
        in: "query",
        type: "string",
        enum: ["bounces", "hardBounces", "softBounces", "delivered", "spam", "requests", "opened", "clicks", "invalid", "deferred", "blocked", "unsubscribed", "error", "loadedByProxy"],
      },
      message_id: { in: "query", type: "string", wireName: "messageId" },
      template_id: { in: "query", type: "integer", wireName: "templateId" },
      days: { in: "query", type: "integer", min: 1, max: 90, description: "Last N days (default 30; not with dates)" },
      start_date: { in: "query", type: "string", wireName: "startDate", description: "YYYY-MM-DD" },
      end_date: { in: "query", type: "string", wireName: "endDate", description: "YYYY-MM-DD" },
      sort: SORT,
    },
    response: offsetPage("events", 2500),
  },
];

const campaignOperations = [
  {
    name: "list_email_campaigns",
    title: "List email campaigns",
    description: "Email campaigns, filtered by type, status or send dates",
    path: "/emailCampaigns",
    params: {
      campaign_type: { in: "query", type: "string", enum: ["classic", "trigger"], wireName: "type" },
      status: { in: "query", type: "string", enum: ["suspended", "archive", "sent", "queued", "draft", "inProcess", "inReview", "cancelling", "cancelled"] },
      statistics: { in: "query", type: "string", enum: ["globalStats", "linksStats", "statsByDomain"] },
      start_date: { in: "query", type: "string", wireName: "startDate", description: "UTC date-time, with end_date (sent campaigns)" },
      end_date: { in: "query", type: "string", wireName: "endDate" },
      exclude_html_content: { in: "query", type: "boolean", default: true, wireName: "excludeHtmlContent", description: "Leave out htmlContent (default true)" },
      sort: SORT,
    },
    response: offsetPage("campaigns", 100),
  },
  {
    name: "get_email_campaign",
    title: "Get email campaign",
    description: "One email campaign with its statistics",
    path: "/emailCampaigns/{campaign_id}",
    params: {
      campaign_id: CAMPAIGN_ID,
      statistics: { in: "query", type: "string", enum: ["globalStats", "linksStats", "statsByDomain", "statsByDevice", "statsByBrowser"] },
      exclude_html_content: { in: "query", type: "boolean", wireName: "excludeHtmlContent" },
    },
  },
  {
    name: "send_campaign_now",
    title: "Send campaign now",
    description: "Send an email campaign to its lists immediately",
    method: "POST",
    path: "/emailCampaigns/{campaign_id}/sendNow",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_email_campaign and look at its status",
    params: { campaign_id: CAMPAIGN_ID },
  },
];

// Webhook configs can hold the receiver's credentials (auth, headers), so they are node only; that also keeps
// the agent's GET-only api_request away from them.
const webhookOperations = [
  { name: "list_webhooks", title: "List webhooks", description: "Webhooks (their auth and headers may hold secrets)", path: "/webhooks", nodeOnly: true, params: { webhook_type: { in: "query", type: "string", enum: ["marketing", "transactional", "inbound"], wireName: "type" } } },
  { name: "get_webhook", title: "Get webhook", description: "One webhook", path: "/webhooks/{webhook_id}", nodeOnly: true, params: { webhook_id: { in: "path", type: "integer", required: true, min: 1 } } },
];

export const restDefinition = defineRestPlugin({
  name: "brevo",
  version: "0.1.0",
  description: "Brevo: contacts and lists, transactional email (agent sends need an opt-in and an optional recipient allowlist), templates, delivery events and campaigns",
  apiName: "Brevo API v3",
  baseUrl: "https://api.brevo.com/v3",
  auth: { type: "header", header: "api-key", env: "BREVO_API_KEY" },
  extraEnv: [RECIPIENT_ALLOWLIST_ENV],
  // Errors are {"code": "...", "message": "..."}.
  errors: {
    messagePath: "message",
    codePath: "code",
    kindByCode: {
      unauthorized: "auth_error",
      permission_denied: "permission_denied",
      not_enough_credits: "permission_denied",
      account_under_validation: "permission_denied",
      not_acceptable: "invalid_input",
      document_not_found: "not_found",
      invalid_parameter: "invalid_input",
      missing_parameter: "invalid_input",
      out_of_range: "invalid_input",
      duplicate_parameter: "invalid_input",
      duplicate_request: "invalid_input",
      campaign_processing: "invalid_input",
      campaign_sent: "invalid_input",
      method_not_allowed: "invalid_input",
    },
  },
  apiRequest: { examplePath: "/senders" },
  operations: [...accountAndContactReads, ...contactWrites, ...listOperations, ...transactionalOperations, ...campaignOperations, ...webhookOperations],
});

/**
 * Applies the plugin's wrappers: recipient checks on the send and (unless turned off for the contract suite, whose
 * api_request probe uses an arbitrary path) the api_request tool path allowlist.
 *
 * @param definition - Definition from defineRestPlugin (object)
 * @param options - `{guardApiRequestPaths}` (object)
 * @returns Wrapped definition (object)
 */
export function wrapBrevoDefinition(definition, { guardApiRequestPaths = true } = {}) {
  const wrapped = replaceOperation(definition, "send_transactional_email", wrapTransactionalSend);
  if (!guardApiRequestPaths) return wrapped;
  return replaceOperation(wrapped, "api_request", (operation) => restrictApiRequestToReadPaths(operation, TOOL_READ_PATH_PREFIXES));
}

export const pluginDefinition = wrapBrevoDefinition(restDefinition);
