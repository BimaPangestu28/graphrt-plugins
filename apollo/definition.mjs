/**
 * apollo plugin definition: Apollo.io REST API v1 (https://docs.apollo.io/reference). Built with the declarative REST
 * layer (docs/declarative-plugins.md). The key goes in the `x-api-key` header. Search and enrichment endpoints take
 * their filters as query parameters (arrays as `name[]=`), even on POST; contacts and accounts searches take JSON.
 *
 * Credits: People API Search, contacts, accounts and sequences cost nothing; Organization Search costs 1 credit per
 * page; people enrichment 1 credit (email/demographics) plus 8 for a mobile number; organization enrichment 1 per
 * company. Billed calls are `write: "unsafe"` with a checkHint, so a timeout is never retried into a second charge.
 *
 * Agent policy:
 * - Bulk enrichment needs APOLLO_TOOL_ALLOW_BULK_ENRICHMENT=1; contact create/update APOLLO_TOOL_ALLOW_CONTACT_WRITES=1.
 * - Phone reveal and waterfall enrichment push results to a webhook_url: only on the node-only
 *   enrich_person_with_callback.
 * - add_contacts_to_sequence is node only: a sequence emails every added contact from the team's mailboxes, and the
 *   recipients are contact ids (or whole labels), so an address allowlist could not be checked without extra
 *   lookups that race with the add.
 * - api_request as a tool may only read TOOL_READ_PATH_PREFIXES (no billed GET such as /organizations/enrich).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { restrictApiRequestToReadPaths } from "./lib/api-request-allowlist.mjs";
import { fillSequenceCampaignId } from "./lib/sequence-id.mjs";
import { capSearchPages } from "./lib/page-limit.mjs";

const PAGED_SEARCHES = new Set(["search_people", "search_organizations", "search_contacts", "search_accounts", "search_sequences"]);

export const BULK_ENRICHMENT_OPT_IN_ENV = "APOLLO_TOOL_ALLOW_BULK_ENRICHMENT";
export const CONTACT_WRITES_OPT_IN_ENV = "APOLLO_TOOL_ALLOW_CONTACT_WRITES";
export const TOOL_READ_PATH_PREFIXES = ["/contacts", "/contact_stages", "/accounts", "/account_stages", "/email_accounts", "/emailer_campaigns", "/labels", "/users", "/auth/health"];
const CREDIT_CHECK_HINT = "the credit usage in Apollo (Settings > Plan & Billing, or get_api_usage) before repeating; enrichment is charged when data is found";
const MAX_SEARCH_PAGE = 100;

const stringList = (wireName, description) => ({ in: "query", type: "array", items: { type: "string" }, style: "brackets", wireName, description });
const queryRange = (wireName, description) => ({ in: "query", type: "integer", min: 0, wireName, description });
const pagedQuery = (dataPath) => ({ dataPath, pagePagination: { pageParam: "page", sizeParam: "per_page", totalPagesPath: "pagination.total_pages" }, paramsIn: "query", maxLimit: MAX_SEARCH_PAGE, defaultLimit: 25 });
const pagedBody = (dataPath) => ({ dataPath, pagePagination: { pageParam: "page", sizeParam: "per_page", totalPagesPath: "pagination.total_pages" }, paramsIn: "body", maxLimit: MAX_SEARCH_PAGE, defaultLimit: 25 });

const organizationFilters = {
  organization_locations: stringList("organization_locations", 'HQ locations, e.g. ["Jakarta, Indonesia"]'),
  organization_not_locations: stringList("organization_not_locations", "Exclude HQ locations"),
  organization_num_employees_ranges: stringList("organization_num_employees_ranges", 'Headcount ranges, e.g. ["11,50", "51,200"]'),
  organization_ids: stringList("organization_ids", "Apollo organization ids"),
  organization_industry_tag_ids: stringList("organization_industry_tag_ids", "Industry tag ids"),
  q_organization_domains_list: stringList("q_organization_domains_list", "Employer domains (up to 1,000)"),
  revenue_min: queryRange("revenue_range[min]", "Minimum annual revenue (USD)"),
  revenue_max: queryRange("revenue_range[max]", "Maximum annual revenue (USD)"),
  currently_using_any_of_technology_uids: stringList("currently_using_any_of_technology_uids", 'Technologies, e.g. ["salesforce", "google_analytics"]'),
};

const personIdentity = {
  first_name: { in: "query", type: "string" },
  last_name: { in: "query", type: "string" },
  name: { in: "query", type: "string", description: "Full name, instead of first_name + last_name" },
  email: { in: "query", type: "string" },
  hashed_email: { in: "query", type: "string", description: "MD5 or SHA-256 hash of the email" },
  organization_name: { in: "query", type: "string" },
  domain: { in: "query", type: "string", description: "Employer domain, e.g. example.com" },
  person_id: { in: "query", type: "string", wireName: "id", description: "Apollo person id (from search_people)" },
  linkedin_url: { in: "query", type: "string" },
  reveal_personal_emails: { in: "query", type: "boolean", description: "Also return personal emails (may cost more credits; not for people in GDPR regions)" },
};

const searchOperations = [
  {
    name: "search_people",
    title: "Search people",
    description: "People API Search over Apollo's database by title, seniority, location and employer filters (no credits; returns names, titles and employers but no emails or phones; use enrich_person for those)",
    method: "POST",
    path: "/mixed_people/api_search",
    write: "idempotent",
    params: {
      person_titles: stringList("person_titles", 'Job titles, e.g. ["marketing manager"]'),
      include_similar_titles: { in: "query", type: "boolean" },
      person_seniorities: stringList("person_seniorities", "owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern"),
      person_locations: stringList("person_locations", 'Where people live, e.g. ["Indonesia"]'),
      q_keywords: { in: "query", type: "string", description: "Keyword filter" },
      contact_email_status: stringList("contact_email_status", "verified, unverified, likely to engage, unavailable"),
      ...organizationFilters,
    },
    response: { ...pagedQuery("people"), pagePagination: { pageParam: "page", sizeParam: "per_page" } },
  },
  {
    name: "search_organizations",
    title: "Search organizations",
    description: "Companies in Apollo's database by name, location, headcount, industry, revenue, technology and funding (1 credit per page of up to 100)",
    method: "POST",
    path: "/mixed_companies/search",
    write: "unsafe",
    checkHint: CREDIT_CHECK_HINT,
    params: {
      q_organization_name: { in: "query", type: "string", description: "Name contains" },
      q_organization_keyword_tags: stringList("q_organization_keyword_tags", 'Keywords, e.g. ["fintech"]'),
      ...organizationFilters,
    },
    response: pagedQuery("organizations"),
  },
];

const enrichmentOperations = [
  {
    name: "enrich_person",
    title: "Enrich person",
    description: "Match one person (by email, name + employer, LinkedIn URL or id) and return their profile and work email (1 credit when data is found)",
    method: "POST",
    path: "/people/match",
    write: "unsafe",
    checkHint: CREDIT_CHECK_HINT,
    params: personIdentity,
  },
  {
    name: "enrich_person_with_callback",
    title: "Enrich person (phone or waterfall)",
    description: "enrich_person plus phone reveal or waterfall enrichment; Apollo delivers those results to webhook_url (mobile numbers cost 8 credits)",
    method: "POST",
    path: "/people/match",
    write: "unsafe",
    nodeOnly: true,
    checkHint: CREDIT_CHECK_HINT,
    params: {
      ...personIdentity,
      reveal_phone_number: { in: "query", type: "boolean" },
      run_waterfall_email: { in: "query", type: "boolean" },
      run_waterfall_phone: { in: "query", type: "boolean" },
      webhook_url: { in: "query", type: "string", required: true, description: "Public https URL Apollo POSTs the asynchronous results to" },
    },
  },
  {
    name: "bulk_enrich_people",
    title: "Bulk enrich people",
    description: "Enrich up to 10 people in one call (1 credit per person found)",
    method: "POST",
    path: "/people/bulk_match",
    write: "unsafe",
    checkHint: CREDIT_CHECK_HINT,
    toolPolicy: `optIn:${BULK_ENRICHMENT_OPT_IN_ENV}`,
    params: {
      details: { in: "body", type: "array", items: { type: "object" }, required: true, maxItems: 10, description: 'People, e.g. [{"email": "ada@example.com"}, {"first_name": "Budi", "last_name": "Santoso", "domain": "example.co.id"}]' },
      reveal_personal_emails: personIdentity.reveal_personal_emails,
    },
  },
  {
    name: "enrich_organization",
    title: "Enrich organization",
    description: "Company profile by domain: industry, headcount, revenue, location, funding, technologies (1 credit)",
    method: "GET",
    path: "/organizations/enrich",
    write: "unsafe",
    checkHint: CREDIT_CHECK_HINT,
    params: {
      domain: { in: "query", type: "string", description: "Company domain, e.g. example.com" },
      linkedin_url: { in: "query", type: "string" },
      website: { in: "query", type: "string" },
      name: { in: "query", type: "string", description: "Company name, to improve the match" },
    },
  },
  {
    name: "bulk_enrich_organizations",
    title: "Bulk enrich organizations",
    description: "Enrich up to 10 companies in one call (1 credit per company)",
    method: "POST",
    path: "/organizations/bulk_enrich",
    write: "unsafe",
    checkHint: CREDIT_CHECK_HINT,
    toolPolicy: `optIn:${BULK_ENRICHMENT_OPT_IN_ENV}`,
    params: { details: { in: "body", type: "array", items: { type: "object" }, required: true, maxItems: 10, description: 'Companies, e.g. [{"domain": "example.com"}, {"name": "Example", "website": "example.co.id"}]' } },
  },
];

const contactFields = {
  first_name: { in: "body", type: "string" },
  last_name: { in: "body", type: "string" },
  organization_name: { in: "body", type: "string" },
  job_title: { in: "body", type: "string", wireName: "title" },
  account_id: { in: "body", type: "string", description: "Apollo account id to link" },
  email: { in: "body", type: "string" },
  website_url: { in: "body", type: "string" },
  label_names: { in: "body", type: "array", items: { type: "string" }, description: "Lists the contact belongs to (replaces existing lists on update)" },
  contact_stage_id: { in: "body", type: "string" },
  present_raw_address: { in: "body", type: "string", description: 'e.g. "Jakarta, Indonesia"' },
  direct_phone: { in: "body", type: "string" },
  corporate_phone: { in: "body", type: "string" },
  mobile_phone: { in: "body", type: "string" },
  typed_custom_fields: { in: "body", type: "object", description: "Custom field values by field id" },
};
const CONTACT_ID = { in: "path", type: "string", required: true, minLength: 1 };

const crmOperations = [
  {
    name: "search_contacts",
    title: "Search contacts",
    description: "Contacts in your Apollo account by keywords, stage and list",
    method: "POST",
    path: "/contacts/search",
    write: "idempotent",
    params: {
      q_keywords: { in: "body", type: "string", description: "Name, title, company or email" },
      contact_stage_ids: { in: "body", type: "array", items: { type: "string" } },
      contact_label_ids: { in: "body", type: "array", items: { type: "string" } },
      sort_by_field: { in: "body", type: "string", enum: ["contact_last_activity_date", "contact_email_last_opened_at", "contact_email_last_clicked_at", "contact_created_at", "contact_updated_at"] },
      sort_ascending: { in: "body", type: "boolean" },
    },
    response: pagedBody("contacts"),
  },
  { name: "get_contact", title: "Get contact", description: "One contact of your Apollo account", path: "/contacts/{contact_id}", params: { contact_id: CONTACT_ID } },
  {
    name: "create_contact",
    title: "Create contact",
    description: "Add a contact to your Apollo account (run_dedupe: overwrite a matching contact instead of creating a duplicate)",
    method: "POST",
    path: "/contacts",
    write: "unsafe",
    toolPolicy: `optIn:${CONTACT_WRITES_OPT_IN_ENV}`,
    checkHint: "search_contacts with the email or name",
    params: { ...contactFields, run_dedupe: { in: "body", type: "boolean", description: "Update the matching contact in place (empty fields clear it)" } },
  },
  {
    name: "update_contact",
    title: "Update contact",
    description: "Change fields of a contact",
    method: "PATCH",
    path: "/contacts/{contact_id}",
    write: "idempotent",
    toolPolicy: `optIn:${CONTACT_WRITES_OPT_IN_ENV}`,
    params: { contact_id: CONTACT_ID, ...contactFields },
  },
  { name: "list_contact_stages", title: "Contact stages", description: "Contact stage ids and names", path: "/contact_stages", response: { dataPath: "contact_stages" } },
  {
    name: "search_accounts",
    title: "Search accounts",
    description: "Accounts (companies) in your Apollo account by name, stage and list",
    method: "POST",
    path: "/accounts/search",
    write: "idempotent",
    params: {
      q_organization_name: { in: "body", type: "string" },
      account_stage_ids: { in: "body", type: "array", items: { type: "string" } },
      account_label_ids: { in: "body", type: "array", items: { type: "string" } },
      sort_by_field: { in: "body", type: "string", enum: ["account_last_activity_date", "account_created_at", "account_updated_at"] },
      sort_ascending: { in: "body", type: "boolean" },
    },
    response: pagedBody("accounts"),
  },
];

const sequenceOperations = [
  {
    name: "search_sequences",
    title: "Search sequences",
    description: "Sequences (emailer campaigns) by name",
    method: "POST",
    path: "/emailer_campaigns/search",
    write: "idempotent",
    params: { q_name: { in: "query", type: "string", description: "Name contains" } },
    response: pagedQuery("emailer_campaigns"),
  },
  { name: "list_email_accounts", title: "Email accounts", description: "Linked mailboxes (ids for add_contacts_to_sequence)", path: "/email_accounts", response: { dataPath: "email_accounts" } },
  {
    name: "add_contacts_to_sequence",
    title: "Add contacts to sequence",
    description: "Enrol contacts in a sequence; Apollo then emails them on the sequence's schedule from the chosen mailbox",
    method: "POST",
    path: "/emailer_campaigns/{sequence_id}/add_contact_ids",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "the sequence's contacts in Apollo before adding again",
    params: {
      sequence_id: { in: "path", type: "string", required: true, minLength: 1 },
      emailer_campaign_id: { in: "query", type: "string", description: "Set by the plugin to sequence_id" },
      contact_ids: stringList("contact_ids", "Contact ids to add"),
      label_names: stringList("label_names", "Add every contact in these lists instead"),
      send_email_from_email_account_id: { in: "query", type: "string", required: true, description: "Mailbox id from list_email_accounts" },
      sequence_status: { in: "query", type: "string", enum: ["active", "paused"], wireName: "status" },
      sequence_active_in_other_campaigns: { in: "query", type: "boolean", description: "Add contacts that are active in another sequence" },
      sequence_unverified_email: { in: "query", type: "boolean", description: "Add contacts with unverified emails" },
    },
  },
  {
    name: "get_api_usage",
    title: "API usage",
    description: "Rate-limit usage per endpoint (minute, hour, day); needs a master API key",
    method: "POST",
    path: "/usage_stats/api_usage_stats",
    write: "idempotent",
  },
];

export const restDefinition = defineRestPlugin({
  name: "apollo",
  version: "0.1.0",
  description: "Apollo.io: people and organization search, person and company enrichment (credits), contacts, accounts and sequences; agent bulk enrichment and contact writes need opt-ins, sequence enrolment and webhook enrichment are node only",
  apiName: "Apollo.io API",
  baseUrl: "https://api.apollo.io/api/v1",
  auth: { type: "header", header: "x-api-key", env: "APOLLO_API_KEY" },
  errors: {
    // Current errors: {"error_details": {code, message}}; legacy root fields {"error", "error_code", "message"}.
    messagePath: ["error_details.message", "error", "message"],
    codePath: "error_details.code",
    kindByCode: {
      "AUTH.AUTHENTICATION.API_KEY_INVALID": "auth_error",
      "AUTH.AUTHORIZATION.ENDPOINT_ACCESS_DENIED": "permission_denied",
      "SEARCH.VALIDATION.WEBHOOK_URL_REQUIRED": "invalid_input",
      "ORGANIZATION.VALIDATION.ORGANIZATION_IDENTIFIER_REQUIRED": "invalid_input",
      "USAGE.RATE_LIMIT.API_RATE_LIMIT_EXCEEDED": "rate_limited",
      "USAGE.RATE_LIMIT.PLATFORM_RATE_LIMIT": "rate_limited",
    },
    kindByStatus: { 422: "invalid_input" },
  },
  apiRequest: { examplePath: "/contact_stages" },
  operations: [...searchOperations, ...enrichmentOperations, ...crmOperations, ...sequenceOperations],
});

/**
 * Applies the sequence id fill-in and (unless turned off for the contract suite, whose api_request probe uses an
 * arbitrary path) the api_request tool path allowlist.
 *
 * @param definition - Definition from defineRestPlugin (object)
 * @param options - `{guardApiRequestPaths}` (object)
 * @returns Wrapped definition (object)
 */
export function wrapApolloDefinition(definition, { guardApiRequestPaths = true } = {}) {
  const operations = definition.operations.map((operation) => {
    if (operation.name === "add_contacts_to_sequence") return fillSequenceCampaignId(operation);
    if (PAGED_SEARCHES.has(operation.name)) return capSearchPages(operation);
    if (guardApiRequestPaths && operation.name === "api_request") return restrictApiRequestToReadPaths(operation, TOOL_READ_PATH_PREFIXES);
    return operation;
  });
  return { ...definition, operations };
}

export const pluginDefinition = wrapApolloDefinition(restDefinition);
