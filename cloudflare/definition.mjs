/**
 * cloudflare plugin definition: accounts, zones, DNS records, cache purge and Workers through the Cloudflare API v4
 * (https://developers.cloudflare.com/api/). Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Agent policy: reads are tools; tools may create and update DNS records only with CLOUDFLARE_TOOL_ALLOW_WRITE=1 and
 * only for names in CLOUDFLARE_TOOL_DNS_ALLOWED_NAMES; deleting DNS records and purging the cache are node only;
 * api_request as a tool only reaches an allowlist of non-secret read paths.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";
import { raiseMinimumLimit, restrictToolDnsNames } from "./lib/cloudflare-wrappers.mjs";

const WRITE_OPT_IN_ENV = "CLOUDFLARE_TOOL_ALLOW_WRITE";
const WRITE_OPT_IN = `optIn:${WRITE_OPT_IN_ENV}`;
const DNS_ALLOWLIST_ENV = "CLOUDFLARE_TOOL_DNS_ALLOWED_NAMES";
// Cloudflare's per_page minimum for zones and accounts (OpenAPI: minimum 5).
const MINIMUM_PAGE_SIZE = 5;
// GET paths agent tools may reach through api_request (normalized: lowercase, decoded, dot segments resolved).
const ID = "[^/]+";
const TOOL_API_PATHS = [
  "/(user|accounts|zones)",
  `/accounts/${ID}`,
  `/zones/${ID}`,
  `/zones/${ID}/(settings|dns_records|pagerules|rulesets|custom_hostnames|available_plans|dnssec|workers/routes|ssl/certificate_packs|ssl/verification)`,
  `/zones/${ID}/(settings|dns_records|pagerules|rulesets|custom_hostnames)/${ID}`,
  `/accounts/${ID}/workers/scripts`,
  `/accounts/${ID}/workers/scripts/${ID}/(settings|deployments|versions|schedules)`,
  `/accounts/${ID}/workers/scripts/${ID}/versions/${ID}`,
].map((pattern) => new RegExp(`^${pattern}$`));
// Refused for tools even when an operator adds them to CLOUDFLARE_TOOL_API_EXTRA_PATHS: tokens (API, tunnel, WARP and
// service tokens), Worker source and secrets, key/value contents, and key material.
const TOOL_API_BLOCKED_PATHS = [/(^|\/)(token|tokens|service_tokens|cfd_tunnel|warp_connector|content|secrets|values|keys|keyless_certificates)(\/|$)/];
const DNS_RECORD_TYPES = ["A", "AAAA", "CAA", "CERT", "CNAME", "DNSKEY", "DS", "HTTPS", "LOC", "MX", "NAPTR", "NS", "OPENPGPKEY", "PTR", "SMIMEA", "SRV", "SSHFP", "SVCB", "TLSA", "TXT", "URI"];
const resultPages = (maxLimit) => ({
  dataPath: "result",
  pagePagination: { pageParam: "page", sizeParam: "per_page", totalPagesPath: "result_info.total_pages" },
  maxLimit,
});

const accountIdParam = { in: "path", type: "string", required: true, description: "Account id (32 hex, from list_accounts)" };
const zoneIdParam = { in: "path", type: "string", required: true, description: "Zone id (32 hex, from list_zones)" };
const recordIdParam = { in: "path", type: "string", required: true, description: "DNS record id" };
const directionParam = { in: "query", type: "string", enum: ["asc", "desc"] };
const dnsRecordBody = {
  record_type: { in: "body", wireName: "type", type: "string", enum: DNS_RECORD_TYPES },
  name: { in: "body", type: "string", minLength: 1, description: 'Record name, e.g. "www.example.com" or "@" for the apex' },
  content: { in: "body", type: "string", description: "Value, e.g. an IPv4 address for A or a hostname for CNAME" },
  ttl: { in: "body", type: "integer", min: 1, max: 86400, description: "Seconds; 1 = automatic" },
  proxied: { in: "body", type: "boolean", description: "Proxy through Cloudflare (A, AAAA, CNAME)" },
  priority: { in: "body", type: "integer", min: 0, max: 65535, description: "MX/URI priority" },
  comment: { in: "body", type: "string" },
  tags: { in: "body", type: "array", items: { type: "string" }, maxItems: 20, description: "name:value tags" },
};

// --- token, accounts, zones -------------------------------------------------------------------------

const accountOperations = [
  {
    name: "verify_token",
    title: "Verify API token",
    description: "Check that the API token is valid and active (status, expiry)",
    path: "/user/tokens/verify",
    response: { dataPath: "result" },
  },
  {
    name: "verify_account_token",
    title: "Verify account API token",
    description: "Check that an account-owned API token is valid and active (account tokens fail verify_token)",
    path: "/accounts/{account_id}/tokens/verify",
    params: { account_id: { in: "path", type: "string", required: true, description: "Account id that owns the token" } },
    response: { dataPath: "result" },
  },
  {
    name: "list_accounts",
    title: "List accounts",
    description: "Accounts the token can access (ids for Workers)",
    path: "/accounts",
    params: { name: { in: "query", type: "string" }, direction: directionParam },
    response: resultPages(50),
  },
  {
    name: "list_zones",
    title: "List zones",
    description: "Zones (domains) the token can access",
    path: "/zones",
    params: {
      name: { in: "query", type: "string", description: "Domain name, e.g. example.com" },
      status: { in: "query", type: "string", enum: ["initializing", "pending", "active", "moved"] },
      account_id: { in: "query", type: "string", wireName: "account.id" },
      order: { in: "query", type: "string", enum: ["name", "status", "account.id", "account.name", "plan.id"] },
      direction: directionParam,
    },
    response: resultPages(50),
  },
  {
    name: "get_zone",
    title: "Get zone",
    description: "One zone: status, plan, name servers, settings summary",
    path: "/zones/{zone_id}",
    params: { zone_id: zoneIdParam },
    response: { dataPath: "result" },
  },
];

// --- DNS ------------------------------------------------------------------------------------------------

const dnsOperations = [
  {
    name: "list_dns_records",
    title: "List DNS records",
    description: "DNS records of a zone, optionally filtered by type, exact name or content",
    path: "/zones/{zone_id}/dns_records",
    params: {
      zone_id: zoneIdParam,
      record_type: { in: "query", wireName: "type", type: "string", enum: DNS_RECORD_TYPES },
      name: { in: "query", type: "string", description: "Exact record name (FQDN)" },
      content: { in: "query", type: "string", description: "Exact record content" },
      proxied: { in: "query", type: "boolean" },
      search: { in: "query", type: "string", description: "Search name, content and comment" },
      order: { in: "query", type: "string", enum: ["type", "name", "content", "ttl", "proxied"] },
      direction: directionParam,
    },
    response: resultPages(1000),
  },
  {
    name: "get_dns_record",
    title: "Get DNS record",
    description: "One DNS record",
    path: "/zones/{zone_id}/dns_records/{record_id}",
    params: { zone_id: zoneIdParam, record_id: recordIdParam },
    response: { dataPath: "result" },
  },
  {
    name: "create_dns_record",
    title: "Create DNS record",
    description: "Add a DNS record to a zone (changes where traffic goes; agent tools only for names in CLOUDFLARE_TOOL_DNS_ALLOWED_NAMES)",
    method: "POST",
    path: "/zones/{zone_id}/dns_records",
    write: "unsafe",
    toolPolicy: WRITE_OPT_IN,
    checkHint: "list_dns_records with the name and type",
    params: {
      zone_id: zoneIdParam,
      ...dnsRecordBody,
      record_type: { ...dnsRecordBody.record_type, required: true },
      name: { ...dnsRecordBody.name, required: true },
      content: { ...dnsRecordBody.content, required: true },
      ttl: { ...dnsRecordBody.ttl, default: 1 },
    },
    response: { dataPath: "result" },
  },
  {
    name: "update_dns_record",
    title: "Update DNS record",
    description: "Change fields of a DNS record (given fields only; agent tools only for names in CLOUDFLARE_TOOL_DNS_ALLOWED_NAMES)",
    method: "PATCH",
    path: "/zones/{zone_id}/dns_records/{record_id}",
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    params: { zone_id: zoneIdParam, record_id: recordIdParam, ...dnsRecordBody },
    response: { dataPath: "result" },
  },
  {
    name: "delete_dns_record",
    title: "Delete DNS record",
    description: "Delete a DNS record",
    method: "DELETE",
    path: "/zones/{zone_id}/dns_records/{record_id}",
    write: "idempotent",
    nodeOnly: true,
    params: { zone_id: zoneIdParam, record_id: recordIdParam },
    response: { dataPath: "result" },
  },
  {
    name: "purge_cache",
    title: "Purge cache",
    description: "Purge cached content of a zone: everything, or by URLs, cache tags, hostnames or prefixes (one kind per call)",
    method: "POST",
    path: "/zones/{zone_id}/purge_cache",
    write: "idempotent",
    nodeOnly: true,
    params: {
      zone_id: zoneIdParam,
      purge_everything: { in: "body", type: "boolean", description: "Purge all cached files of the zone" },
      files: { in: "body", type: "array", items: { type: "string" }, maxItems: 100, description: "Full URLs to purge" },
      tags: { in: "body", type: "array", items: { type: "string" }, maxItems: 100, description: "Cache-Tag values" },
      hosts: { in: "body", type: "array", items: { type: "string" }, maxItems: 100, description: "Hostnames" },
      prefixes: { in: "body", type: "array", items: { type: "string" }, maxItems: 100, description: "URL prefixes without scheme, e.g. www.example.com/blog" },
    },
    response: { dataPath: "result" },
  },
];

// --- Workers ----------------------------------------------------------------------------------------------

const workerScriptParams = { account_id: accountIdParam, script_name: { in: "path", type: "string", required: true, description: "Worker name" } };
const workerOperations = [
  {
    name: "list_workers",
    title: "List Workers",
    description: "Worker scripts of an account with created/modified times and handlers",
    path: "/accounts/{account_id}/workers/scripts",
    params: { account_id: accountIdParam, tags: { in: "query", type: "string", description: "Filter by tags, e.g. env:prod" } },
    response: { dataPath: "result" },
  },
  {
    name: "get_worker_settings",
    title: "Get Worker settings",
    description: "Settings of a Worker: bindings (names and types, never secret values), compatibility date and flags, observability",
    path: "/accounts/{account_id}/workers/scripts/{script_name}/settings",
    params: workerScriptParams,
    response: { dataPath: "result" },
  },
  {
    name: "list_worker_deployments",
    title: "List Worker deployments",
    description: "Deployments of a Worker (which versions serve traffic, and their split)",
    path: "/accounts/{account_id}/workers/scripts/{script_name}/deployments",
    params: workerScriptParams,
    response: { dataPath: "result.deployments" },
  },
];

const restDefinition = defineRestPlugin({
  name: "cloudflare",
  version: "0.1.0",
  description: "Cloudflare API v4: accounts, zones, DNS records (list, create, update; delete node only), cache purge (node only) and Workers",
  apiName: "Cloudflare API",
  baseUrl: "https://api.cloudflare.com/client/v4",
  auth: { type: "bearer", env: "CLOUDFLARE_API_TOKEN" },
  extraEnv: [DNS_ALLOWLIST_ENV, "CLOUDFLARE_TOOL_API_EXTRA_PATHS"],
  // Errors are {"success": false, "errors": [{"code": 1000, "message": "Invalid API Token"}], "result": null}.
  errors: {
    messagePath: ["errors.0.message", "errors.0.error_chain.0.message"],
    codePath: "errors.0.code",
    kindByCode: { 1000: "auth_error", 9109: "auth_error", 10000: "auth_error", 6003: "auth_error" },
    okPath: "success",
  },
  apiRequest: { examplePath: "/zones/<zone_id>/settings" },
  operations: [...accountOperations, ...dnsOperations, ...workerOperations],
});

const guardedDefinition = guardToolApiRequest(restDefinition, {
  allowedPaths: TOOL_API_PATHS,
  blockedPaths: TOOL_API_BLOCKED_PATHS,
  extraAllowedPathsEnv: "CLOUDFLARE_TOOL_API_EXTRA_PATHS",
  reason: "agent tools may only read accounts, zones, zone settings, DNS records and Worker metadata; use a workflow node",
});
const dnsLimitedDefinition = restrictToolDnsNames(guardedDefinition, {
  createOperation: "create_dns_record",
  updateOperation: "update_dns_record",
  allowlistEnv: DNS_ALLOWLIST_ENV,
  optInEnv: WRITE_OPT_IN_ENV,
});

export const pluginDefinition = raiseMinimumLimit(dnsLimitedDefinition, { operationNames: ["list_zones", "list_accounts"], minimumLimit: MINIMUM_PAGE_SIZE });
