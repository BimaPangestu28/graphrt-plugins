/**
 * google-search-console plugin definition: Google Search Console API v1 (https://developers.google.com/webmaster-tools/v1/api_reference_index).
 * Every method lives on https://searchconsole.googleapis.com: sites, sitemaps and Search Analytics under the
 * `webmasters/v3` paths it still serves, URL Inspection under `v1`. Built with the declarative REST layer
 * (docs/declarative-plugins.md); Google credentials come from the shared Google auth files (lib/google-rest-auth.mjs
 * and friends, copied byte for byte from google-analytics).
 *
 * Scope: reads ask for `webmasters.readonly`; only write requests (PUT, DELETE) ask for `webmasters`, so a service
 * account token used for reads can never write. (A refresh token carries the scopes it was granted with.)
 *
 * Agent policy: reads are tools. Adding a site and submitting a sitemap need GOOGLE_SEARCH_CONSOLE_TOOL_ALLOW_WRITES=1
 * as tools; removing a site or a sitemap is node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { createGoogleAuth, createGoogleErrors, withGoogleCredentials } from "./lib/google-rest-auth.mjs";

export const WRITE_OPT_IN_ENV = "GOOGLE_SEARCH_CONSOLE_TOOL_ALLOW_WRITES";
export const READONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const WRITE_SCOPE = "https://www.googleapis.com/auth/webmasters";
const WRITE_METHODS = new Set(["PUT", "DELETE", "PATCH"]);
const SITES = "/webmasters/v3/sites";
const SEARCH_DIMENSIONS = ["date", "hour", "query", "page", "country", "device", "searchAppearance"];
const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"];

const SITE_URL = {
  in: "path",
  type: "string",
  required: true,
  minLength: 1,
  description: 'Property as Search Console names it: "https://www.example.com/" (URL-prefix, with the trailing slash) or "sc-domain:example.com" (Domain property)',
};
const SITEMAP_URL = { in: "path", type: "string", required: true, minLength: 1, description: "Full sitemap URL, e.g. https://www.example.com/sitemap.xml" };

/**
 * Picks the narrowest scope per request: `webmasters` only for writes.
 *
 * @returns `custom` auth spec (object)
 */
function createSearchConsoleAuth() {
  const readAuth = createGoogleAuth(READONLY_SCOPE);
  const writeAuth = createGoogleAuth(WRITE_SCOPE);
  return {
    type: "custom",
    env: readAuth.env,
    authorize: (request) => (WRITE_METHODS.has(request.method) ? writeAuth : readAuth).authorize(request),
  };
}

const siteOperations = [
  { name: "list_sites", title: "List sites", description: "Properties the caller can access, with permission levels (siteOwner, siteFullUser, siteRestrictedUser, siteUnverifiedUser)", path: SITES, response: { dataPath: "siteEntry" } },
  { name: "get_site", title: "Get site", description: "One property and the caller's permission level", path: `${SITES}/{site_url}`, params: { site_url: SITE_URL } },
  {
    name: "add_site",
    title: "Add site",
    description: "Add a property to the caller's Search Console account (it still has to be verified)",
    method: "PUT",
    path: `${SITES}/{site_url}`,
    write: "idempotent",
    toolPolicy: `optIn:${WRITE_OPT_IN_ENV}`,
    params: { site_url: SITE_URL },
  },
  {
    name: "delete_site",
    title: "Remove site",
    description: "Remove a property from the caller's Search Console account",
    method: "DELETE",
    path: `${SITES}/{site_url}`,
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_sites and look for the property",
    params: { site_url: SITE_URL },
  },
];

const searchAnalyticsOperation = {
  name: "query_search_analytics",
  title: "Search analytics",
  description: "Clicks, impressions, CTR and position from Google Search, grouped by dimensions (query, page, country, device, date, ...) over a date range, with filters",
  method: "POST",
  path: `${SITES}/{site_url}/searchAnalytics/query`,
  // A POST that only reads.
  write: "idempotent",
  params: {
    site_url: SITE_URL,
    start_date: { in: "body", type: "string", required: true, wireName: "startDate", description: "First day, YYYY-MM-DD (Pacific time)" },
    end_date: { in: "body", type: "string", required: true, wireName: "endDate", description: "Last day (inclusive), YYYY-MM-DD" },
    dimensions: { in: "body", type: "array", items: { type: "string", enum: SEARCH_DIMENSIONS }, description: "Group-by dimensions, in order: date, hour, query, page, country, device, searchAppearance" },
    search_type: { in: "body", type: "string", enum: SEARCH_TYPES, wireName: "type", description: "Search type (default web)" },
    dimension_filter_groups: {
      in: "body",
      type: "array",
      items: { type: "object" },
      wireName: "dimensionFilterGroups",
      description: 'Filters, e.g. [{"filters": [{"dimension": "query", "operator": "contains", "expression": "sepatu"}]}] (operators: equals, notEquals, contains, notContains, includingRegex, excludingRegex)',
    },
    aggregation_type: { in: "body", type: "string", enum: ["auto", "byProperty", "byPage", "byNewsShowcasePanel"], wireName: "aggregationType", description: "How rows are aggregated (default auto)" },
    data_state: { in: "body", type: "string", enum: ["final", "all", "hourly_all"], wireName: "dataState", description: "final (default) excludes fresh partial data; all includes it; hourly_all is needed with the hour dimension" },
  },
  // limit = rowLimit (1..25000), cursor = startRow; next_cursor is set while a page comes back full.
  response: { dataPath: "rows", offsetPagination: { offsetParam: "startRow", limitParam: "rowLimit" }, paramsIn: "body", maxLimit: 25000, defaultLimit: 1000 },
};

const sitemapOperations = [
  {
    name: "list_sitemaps",
    title: "List sitemaps",
    description: "Sitemaps submitted for the property (or listed in a sitemap index), with errors, warnings and last download",
    path: `${SITES}/{site_url}/sitemaps`,
    params: { site_url: SITE_URL, sitemap_index: { in: "query", type: "string", wireName: "sitemapIndex", description: "URL of a sitemap index: list the sitemaps in it" } },
    response: { dataPath: "sitemap" },
  },
  { name: "get_sitemap", title: "Get sitemap", description: "One sitemap's status, errors, warnings and content counts", path: `${SITES}/{site_url}/sitemaps/{sitemap_url}`, params: { site_url: SITE_URL, sitemap_url: SITEMAP_URL } },
  {
    name: "submit_sitemap",
    title: "Submit sitemap",
    description: "Submit (or resubmit) a sitemap for the property",
    method: "PUT",
    path: `${SITES}/{site_url}/sitemaps/{sitemap_url}`,
    write: "idempotent",
    toolPolicy: `optIn:${WRITE_OPT_IN_ENV}`,
    params: { site_url: SITE_URL, sitemap_url: SITEMAP_URL },
  },
  {
    name: "delete_sitemap",
    title: "Delete sitemap",
    description: "Remove a sitemap from the property's sitemap report",
    method: "DELETE",
    path: `${SITES}/{site_url}/sitemaps/{sitemap_url}`,
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_sitemaps for the property",
    params: { site_url: SITE_URL, sitemap_url: SITEMAP_URL },
  },
];

const urlInspectionOperation = {
  name: "inspect_url",
  title: "Inspect URL",
  description: "Google's index status of one URL: coverage, last crawl, canonical, mobile usability, rich results, AMP",
  method: "POST",
  path: "/v1/urlInspection/index:inspect",
  write: "idempotent",
  params: {
    inspection_url: { in: "body", type: "string", required: true, minLength: 1, wireName: "inspectionUrl", description: "Fully-qualified URL to inspect; must be under site_url" },
    site_url: { in: "body", type: "string", required: true, minLength: 1, wireName: "siteUrl", description: SITE_URL.description },
    language_code: { in: "body", type: "string", wireName: "languageCode", description: "BCP-47 language for issue messages, e.g. id or en-US (default en-US)" },
  },
  response: { dataPath: "inspectionResult" },
};

export const pluginDefinition = withGoogleCredentials(
  defineRestPlugin({
    name: "google-search-console",
    version: "0.1.0",
    description: "Google Search Console: search analytics (clicks, impressions, CTR, position), URL inspection, sites and sitemaps; agent writes need an opt-in, removals are node only (OAuth or service account)",
    apiName: "Google Search Console API",
    baseUrl: "https://searchconsole.googleapis.com",
    auth: createSearchConsoleAuth(),
    extraEnv: [WRITE_OPT_IN_ENV],
    // Search Console still answers in the v3 style: {"error": {"code", "message", "errors": [{"reason"}], "status"?}}.
    errors: { ...createGoogleErrors("error.status"), messagePath: ["error.message", "error.errors.0.message"] },
    apiRequest: { examplePath: "/webmasters/v3/sites" },
    operations: [...siteOperations, searchAnalyticsOperation, ...sitemapOperations, urlInspectionOperation],
  }),
);
