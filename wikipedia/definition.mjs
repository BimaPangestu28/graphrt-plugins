/**
 * wikipedia plugin definition: search and read Wikipedia through the MediaWiki Action API (/w/api.php) and the
 * REST v1 API (/api/rest_v1). No account or key. Built with the declarative REST layer
 * (docs/declarative-plugins.md) plus two small wrappers (lib/wikipedia-wrappers.mjs):
 *   - `language` on every operation picks the wiki (en, id, de, ...); WIKIPEDIA_LANGUAGE sets the default;
 *   - `get_page_content` caps the plain text at `max_chars`.
 *
 * Wikimedia's User-Agent policy (https://meta.wikimedia.org/wiki/User-Agent_policy) asks clients for a
 * descriptive User-Agent with contact information; every request sends USER_AGENT.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { capPageContent, LANGUAGE_ENV, resolveWikipediaUrl, withLanguage } from "./lib/wikipedia-wrappers.mjs";

const VERSION = "0.1.0";
export const USER_AGENT = `graphrt-wikipedia-plugin/${VERSION} (https://github.com/BimaPangestu28/graphrt-plugins; graphrt workflow plugin)`;
const ACTION_API = "/w/api.php";
const ACTION_QUERY = { action: "query", format: "json", formatversion: "2" };
const pageTitleParam = (location, wireName) => ({
  in: location,
  type: "string",
  required: true,
  minLength: 1,
  ...(wireName ? { wireName } : {}),
  description: 'Page title, e.g. "Borobudur" (spaces are fine; redirects are followed)',
});

const searchPages = {
  name: "search_pages",
  title: "Search Wikipedia",
  description: "Full-text search: title, pageid, snippet (HTML with <span class=searchmatch>), wordcount and timestamp of matching articles",
  path: ACTION_API,
  params: {
    query: { in: "query", type: "string", required: true, minLength: 1, wireName: "srsearch", description: "Search text; supports intitle:, incategory:, quotes" },
  },
  constants: { query: { ...ACTION_QUERY, list: "search" } },
  response: { dataPath: "query.search", offsetPagination: { offsetParam: "sroffset", limitParam: "srlimit", totalPath: "query.searchinfo.totalhits" }, maxLimit: 500, defaultLimit: 10 },
};

const getPageSummary = {
  name: "get_page_summary",
  title: "Page summary",
  description: "Short summary of a page: title, description, extract (plain text lead), thumbnail, coordinates and URLs",
  path: "/api/rest_v1/page/summary/{page_title}",
  params: { page_title: pageTitleParam("path") },
};

const getPageContent = {
  name: "get_page_content",
  title: "Page content (plain text)",
  description: "The article as plain text (section headings as lines), capped at max_chars: {pageid, title, extract, truncated, total_chars}",
  path: ACTION_API,
  params: {
    page_title: pageTitleParam("query", "titles"),
    intro_only: { in: "query", type: "boolean", wireName: "exintro", description: "Only the lead section before the first heading" },
  },
  constants: { query: { ...ACTION_QUERY, prop: "extracts", explaintext: "1", redirects: "1" } },
  response: { dataPath: "query.pages.0" },
};

const getPageMedia = {
  name: "get_page_media",
  title: "Page media list",
  description: "Images, audio and video used on a page: title (File:...), type, caption and srcset thumbnail URLs",
  path: "/api/rest_v1/page/media-list/{page_title}",
  params: { page_title: pageTitleParam("path") },
  response: { dataPath: "items" },
};

const searchNearbyPages = {
  name: "search_nearby_pages",
  title: "Pages near a place",
  description: "Articles with coordinates near a point, nearest first: title, pageid, lat, lon, dist (meters)",
  path: ACTION_API,
  params: {
    coordinates: { in: "query", type: "string", required: true, wireName: "gscoord", description: 'Latitude and longitude separated by "|", e.g. "-7.6079|110.2038"' },
    radius_meters: { in: "query", type: "integer", min: 10, max: 10000, default: 1000, wireName: "gsradius", description: "Search radius in meters (10-10000)" },
    limit: { in: "query", type: "integer", min: 1, max: 500, default: 10, wireName: "gslimit", description: "Maximum pages" },
  },
  constants: { query: { ...ACTION_QUERY, list: "geosearch" } },
  response: { dataPath: "query.geosearch" },
};

const getPageLanguages = {
  name: "get_page_languages",
  title: "Page in other languages",
  description: "The same article in other Wikipedias: langlinks [{lang, title, url}]; next_cursor when there are more than limit",
  path: ACTION_API,
  params: {
    page_title: pageTitleParam("query", "titles"),
  },
  constants: { query: { ...ACTION_QUERY, prop: "langlinks", llprop: "url", redirects: "1" } },
  // More than `limit` languages: MediaWiki returns continue.llcontinue, which becomes next_cursor.
  response: { dataPath: "query.pages.0", cursorPath: "continue.llcontinue", cursorParam: "llcontinue", limitParam: "lllimit", maxLimit: 500, defaultLimit: 500 },
};

export const restDefinition = defineRestPlugin({
  name: "wikipedia",
  version: VERSION,
  description: "Wikipedia (any language, no API key): search, page summaries, plain-text content, media lists, nearby pages and language links",
  apiName: "Wikipedia (MediaWiki Action and REST v1 APIs)",
  extraEnv: [LANGUAGE_ENV],
  baseUrl: resolveWikipediaUrl,
  allowedHostSuffix: ".wikipedia.org",
  auth: { type: "none" },
  defaultHeaders: { "user-agent": USER_AGENT },
  // Action API errors come with HTTP 200: {"error": {"code": "badvalue", "info": "..."}}. REST errors are
  // {"status": 404, "type": "...", "title": "Not found.", "detail": "..."}.
  errors: {
    messagePath: ["error.info", "detail", "title"],
    codePath: "error.code",
    errorPath: "error",
    kindByCode: {
      badvalue: "invalid_input",
      badinteger: "invalid_input",
      missingparam: "invalid_input",
      paramempty: "invalid_input",
      invalidtitle: "invalid_input",
      toomanyvalues: "invalid_input",
      ratelimited: "rate_limited",
      maxlag: "rate_limited",
    },
    retryableCodes: ["maxlag"],
  },
  apiRequest: { examplePath: "/w/api.php?action=query&list=random&rnnamespace=0&format=json" },
  operations: [searchPages, getPageSummary, getPageContent, getPageMedia, searchNearbyPages, getPageLanguages],
});

const wrapOperation = (operation) => {
  if (operation.name === "api_request") return operation;
  const languageAware = withLanguage(operation);
  return operation.name === "get_page_content" ? capPageContent(languageAware) : languageAware;
};

export const pluginDefinition = { ...restDefinition, operations: restDefinition.operations.map(wrapOperation) };
