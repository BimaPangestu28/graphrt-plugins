/**
 * hunter plugin definition: Hunter.io API v2 (https://hunter.io/api-documentation/v2). Built with the declarative
 * REST layer (docs/declarative-plugins.md). The API key goes in the `X-API-KEY` header (never the query, so it
 * cannot leak through logged URLs). Responses are `{data, meta}`; errors are `{"errors": [{id, code, details}]}`.
 *
 * Credits: Domain Search, Email Finder and the enrichment endpoints use searches/credits, Email Verifier uses
 * verifications. Those GETs are `write: "unsafe"` with a checkHint, so a timeout is never retried into a second
 * charge. Email Count, Discover, account and leads calls are free.
 *
 * Agent policy: lead and leads-list writes need HUNTER_TOOL_ALLOW_LEAD_WRITES=1 as tools; deletes are node only.
 * api_request as a tool may only read the free paths in TOOL_READ_PATH_PREFIXES (so it cannot reach the billed
 * GET endpoints with the layer's read retries).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { restrictApiRequestToReadPaths } from "./lib/api-request-allowlist.mjs";
import { reportPendingVerification } from "./lib/verification-pending.mjs";

export const LEAD_WRITES_OPT_IN_ENV = "HUNTER_TOOL_ALLOW_LEAD_WRITES";
export const TOOL_READ_PATH_PREFIXES = ["/account", "/email-count", "/leads", "/leads_lists", "/leads-lists"];
const SEARCH_CHECK_HINT = "get_account (requests.searches or requests.credits `used`) before repeating; Hunter does not charge again for the same search in a billing period";
const VERIFY_CHECK_HINT = "get_account (requests.verifications or requests.credits `used`); a repeated verification of the same address may be charged again";
const LEAD_WRITE_POLICY = `optIn:${LEAD_WRITES_OPT_IN_ENV}`;

const DOMAIN = { in: "query", type: "string", description: "Domain, e.g. stripe.com (takes precedence over company)" };
const COMPANY = { in: "query", type: "string", description: "Company name, when the domain is unknown (less accurate)" };
const LEAD_ID = { in: "path", type: "integer", required: true, min: 1, description: "Lead id" };
const LIST_ID = { in: "path", type: "integer", required: true, min: 1, description: "Leads list id" };

const leadFields = (emailRequired) => ({
  email: { in: "body", type: "string", required: emailRequired, minLength: 3, description: "Email address" },
  first_name: { in: "body", type: "string" },
  last_name: { in: "body", type: "string" },
  job_position: { in: "body", type: "string", wireName: "position", description: "Job title" },
  company: { in: "body", type: "string" },
  company_industry: { in: "body", type: "string" },
  company_size: { in: "body", type: "string", description: 'e.g. "11-50"' },
  confidence_score: { in: "body", type: "integer", min: 0, max: 100 },
  website: { in: "body", type: "string" },
  country_code: { in: "body", type: "string", description: "ISO 3166-1 alpha-2, e.g. ID" },
  linkedin_url: { in: "body", type: "string" },
  phone_number: { in: "body", type: "string" },
  twitter: { in: "body", type: "string" },
  notes: { in: "body", type: "string" },
  source: { in: "body", type: "string" },
  leads_list_id: { in: "body", type: "integer", min: 1, description: "Add the lead to this list" },
  leads_list_ids: { in: "body", type: "array", items: { type: "integer" }, description: "Add the lead to these lists" },
  custom_attributes: { in: "body", type: "object", description: 'Custom attribute values by slug, e.g. {"segment": "retail"}' },
});

const searchOperations = [
  {
    name: "domain_search",
    title: "Domain search",
    description: "Email addresses Hunter knows for a domain or company, with names, positions, sources and the email pattern (uses search credits)",
    method: "GET",
    path: "/domain-search",
    write: "unsafe",
    checkHint: SEARCH_CHECK_HINT,
    params: {
      domain: DOMAIN,
      company: COMPANY,
      limit: { in: "query", type: "integer", min: 1, max: 100, description: "Emails to return (default 10, max 100)" },
      offset: { in: "query", type: "integer", min: 0, description: "Emails to skip" },
      email_type: { in: "query", type: "string", enum: ["personal", "generic"], wireName: "type" },
      seniority: { in: "query", type: "array", items: { type: "string", enum: ["junior", "senior", "executive"] } },
      department: { in: "query", type: "array", items: { type: "string" }, description: "e.g. executive, it, finance, management, sales, legal, support, hr, marketing, communication, education, design, health, operations" },
      required_field: { in: "query", type: "array", items: { type: "string", enum: ["full_name", "position", "phone_number"] } },
      verification_status: { in: "query", type: "array", items: { type: "string", enum: ["valid", "accept_all", "unknown"] } },
    },
  },
  {
    name: "find_email",
    title: "Email finder",
    description: "The most likely email address of a person at a domain or company, with a confidence score (uses a search credit when an email is found)",
    method: "GET",
    path: "/email-finder",
    write: "unsafe",
    checkHint: SEARCH_CHECK_HINT,
    params: {
      domain: DOMAIN,
      company: COMPANY,
      first_name: { in: "query", type: "string" },
      last_name: { in: "query", type: "string" },
      full_name: { in: "query", type: "string", description: "Instead of first_name + last_name" },
      linkedin_handle: { in: "query", type: "string", description: "LinkedIn profile handle, instead of the name and domain" },
      max_duration: { in: "query", type: "integer", min: 3, max: 20, description: "Seconds Hunter may spend (default 10)" },
    },
  },
  {
    name: "verify_email",
    title: "Email verifier",
    description: "Deliverability of an email address: status valid, invalid, accept_all, webmail, disposable or unknown, with score and checks (uses a verification credit)",
    method: "GET",
    path: "/email-verifier",
    write: "unsafe",
    checkHint: VERIFY_CHECK_HINT,
    params: { email: { in: "query", type: "string", required: true, minLength: 3 } },
  },
  {
    name: "count_emails",
    title: "Email count",
    description: "How many addresses Hunter has for a domain or company, by type, department and seniority (free)",
    path: "/email-count",
    params: { domain: DOMAIN, company: COMPANY, email_type: { in: "query", type: "string", enum: ["personal", "generic"], wireName: "type" } },
  },
  {
    name: "enrich_person",
    title: "Person enrichment",
    description: "Profile of the person behind an email address or LinkedIn handle: name, location, employment, social handles (uses 0.2 credit when found)",
    method: "GET",
    path: "/people/find",
    write: "unsafe",
    checkHint: SEARCH_CHECK_HINT,
    params: { email: { in: "query", type: "string" }, linkedin_handle: { in: "query", type: "string" } },
  },
  {
    name: "enrich_company",
    title: "Company enrichment",
    description: "Company profile for a domain: name, industry, size, location, tech, social handles (uses 0.2 credit when found)",
    method: "GET",
    path: "/companies/find",
    write: "unsafe",
    checkHint: SEARCH_CHECK_HINT,
    params: { domain: { in: "query", type: "string", required: true, minLength: 3 } },
  },
  {
    name: "discover_companies",
    title: "Discover companies",
    description: "Find companies by a natural-language query or filters (location, industry, headcount, technology, ...), with how many emails Hunter has for each (free)",
    method: "POST",
    path: "/discover",
    write: "idempotent",
    params: {
      query: { in: "body", type: "string", description: 'Natural-language search, e.g. "fintech companies in Jakarta"' },
      organization: { in: "body", type: "object", description: 'e.g. {"domain": ["stripe.com"]} or {"name": ["Stripe"]}' },
      headquarters_location: { in: "body", type: "object", description: 'e.g. {"include": [{"country": "ID", "city": "Jakarta"}]}' },
      industry: { in: "body", type: "object", description: 'e.g. {"include": ["Financial Services"]}' },
      headcount: { in: "body", type: "array", items: { type: "string" }, description: 'e.g. ["11-50", "51-200"]' },
      company_type: { in: "body", type: "object", description: 'e.g. {"include": ["privately held"]}' },
      technology: { in: "body", type: "object", description: 'e.g. {"include": ["shopify"]}' },
      keywords: { in: "body", type: "object", description: 'e.g. {"include": ["payments"], "match": "any"}' },
      limit: { in: "body", type: "integer", min: 1, max: 100, description: "Companies to return (max 100)" },
      offset: { in: "body", type: "integer", min: 0, max: 10000, description: "Companies to skip (paid plans)" },
    },
  },
  { name: "get_account", title: "Account", description: "Plan, reset date and remaining searches, verifications or credits", path: "/account" },
];

const leadOperations = [
  {
    name: "list_leads",
    title: "List leads",
    description: "Saved leads, optionally filtered by list, email, company, name or country",
    path: "/leads",
    params: {
      leads_list_id: { in: "query", type: "integer", min: 1 },
      email: { in: "query", type: "string" },
      first_name: { in: "query", type: "string" },
      last_name: { in: "query", type: "string" },
      company: { in: "query", type: "string" },
      country_code: { in: "query", type: "string" },
    },
    response: { dataPath: "data.leads", offsetPagination: { offsetParam: "offset", limitParam: "limit", totalPath: "meta.total" }, maxLimit: 1000, defaultLimit: 100 },
  },
  { name: "get_lead", title: "Get lead", description: "One saved lead", path: "/leads/{lead_id}", params: { lead_id: LEAD_ID } },
  {
    name: "create_lead",
    title: "Create lead",
    description: "Save a lead (an existing email gets the new list memberships instead)",
    method: "POST",
    path: "/leads",
    write: "unsafe",
    toolPolicy: LEAD_WRITE_POLICY,
    checkHint: "list_leads with the email",
    params: leadFields(true),
  },
  {
    name: "upsert_lead",
    title: "Create or update lead",
    description: "Create a lead, or update the lead with the same email",
    method: "PUT",
    path: "/leads",
    write: "idempotent",
    toolPolicy: LEAD_WRITE_POLICY,
    params: leadFields(true),
  },
  {
    name: "update_lead",
    title: "Update lead",
    description: "Change fields of a lead (an empty string clears a custom attribute)",
    method: "PUT",
    path: "/leads/{lead_id}",
    write: "idempotent",
    toolPolicy: LEAD_WRITE_POLICY,
    params: { lead_id: LEAD_ID, ...leadFields(false) },
  },
  { name: "delete_lead", title: "Delete lead", description: "Delete a lead", method: "DELETE", path: "/leads/{lead_id}", write: "unsafe", nodeOnly: true, checkHint: "get_lead", params: { lead_id: LEAD_ID } },
];

const listOperations = [
  {
    name: "list_leads_lists",
    title: "List leads lists",
    description: "Leads lists with their lead counts",
    path: "/leads_lists",
    response: { dataPath: "data.leads_lists", offsetPagination: { offsetParam: "offset", limitParam: "limit", totalPath: "meta.total" }, maxLimit: 100, defaultLimit: 20 },
  },
  {
    name: "get_leads_list",
    title: "Get leads list",
    description: "One leads list with a page of its leads",
    path: "/leads_lists/{list_id}",
    params: { list_id: LIST_ID, limit: { in: "query", type: "integer", min: 1, max: 100, description: "Leads to include (default 20)" }, offset: { in: "query", type: "integer", min: 0 } },
  },
  {
    name: "create_leads_list",
    title: "Create leads list",
    description: "Create a leads list",
    method: "POST",
    path: "/leads_lists",
    write: "unsafe",
    toolPolicy: LEAD_WRITE_POLICY,
    checkHint: "list_leads_lists and look for the name",
    params: { name: { in: "body", type: "string", required: true, minLength: 1, description: "List name (up to 255 characters)" } },
  },
  {
    name: "update_leads_list",
    title: "Rename leads list",
    description: "Rename a leads list",
    method: "PUT",
    path: "/leads_lists/{list_id}",
    write: "idempotent",
    toolPolicy: LEAD_WRITE_POLICY,
    params: { list_id: LIST_ID, name: { in: "body", type: "string", required: true, minLength: 1, description: "List name (up to 255 characters)" } },
  },
  { name: "delete_leads_list", title: "Delete leads list", description: "Delete a leads list", method: "DELETE", path: "/leads_lists/{list_id}", write: "unsafe", nodeOnly: true, checkHint: "get_leads_list", params: { list_id: LIST_ID } },
];

export const restDefinition = defineRestPlugin({
  name: "hunter",
  version: "0.1.0",
  description: "Hunter.io: domain search, email finder and verifier (credits), email count, enrichment, company discovery, account, leads and leads lists; agent lead writes need an opt-in, deletes are node only",
  apiName: "Hunter API v2",
  baseUrl: "https://api.hunter.io/v2",
  auth: { type: "header", header: "X-API-KEY", env: "HUNTER_API_KEY" },
  extraEnv: [LEAD_WRITES_OPT_IN_ENV],
  errors: {
    messagePath: ["errors.0.details", "errors.0.id"],
    codePath: "errors.0.id",
    kindByCode: {
      wrong_params: "invalid_input",
      pagination_error: "invalid_input",
      invalid_domain: "invalid_input",
      invalid_email: "invalid_input",
      not_found: "not_found",
      too_many_requests: "rate_limited",
      no_discover_access: "permission_denied",
      claimed_email: "permission_denied",
    },
    // Hunter: 403 = rate limit reached, 429 = the plan's usage limit is used up (waiting does not help).
    kindByStatus: { 403: "rate_limited", 429: "permission_denied", 451: "permission_denied" },
  },
  apiRequest: { examplePath: "/account" },
  operations: [...searchOperations, ...leadOperations, ...listOperations],
});

/**
 * Applies the verify_email pending mapping and the api_request tool path allowlist (the latter turned off for the
 * contract suite, whose api_request probe uses an
 * arbitrary path).
 *
 * @param definition - Definition from defineRestPlugin (object)
 * @param options - `{guardApiRequestPaths}` (object)
 * @returns Wrapped definition (object)
 */
export function wrapHunterDefinition(definition, { guardApiRequestPaths = true } = {}) {
  const operations = definition.operations.map((operation) => {
    if (operation.name === "verify_email") return reportPendingVerification(operation);
    if (guardApiRequestPaths && operation.name === "api_request") return restrictApiRequestToReadPaths(operation, TOOL_READ_PATH_PREFIXES);
    return operation;
  });
  return { ...definition, operations };
}

export const pluginDefinition = wrapHunterDefinition(restDefinition);
