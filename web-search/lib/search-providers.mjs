/**
 * The three search providers web-search can use, each a small declarative REST definition (so each gets the shared
 * client's auth, redaction, error mapping and the generated contract tests), plus an adapter that turns the
 * plugin's provider-neutral arguments into the provider's request and its response into neutral results.
 *
 * Every provider bills per query, so each search is `write: "unsafe"`: never retried after a 5xx, timeout or
 * network error (the provider may already have counted it). 429s are still retried: nothing ran.
 */
import { defineRestPlugin } from "./shared/rest-plugin.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const KEY_ENV = "WEB_SEARCH_API_KEY";
const VERSION = "0.1.0";
const listParam = (description) => ({ in: "body", type: "array", items: { type: "string" }, maxItems: 100, description });
// Provider-neutral freshness values mapped to each provider's own.
const BRAVE_FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" };
const SERPAPI_FRESHNESS = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };
const SERPAPI_NO_RESULTS = /hasn't returned any results/i;
// Plan quota and hourly throughput errors, which SerpAPI may send with HTTP 200 ("run out of searches",
// "searches for the month are exhausted", "exceeded the hourly throughput limit").
const SERPAPI_QUOTA_EXCEEDED = /run out of searches|searches for the month are exhausted|throughput limit|plan limit/i;

// --- Tavily (https://docs.tavily.com/documentation/api-reference/endpoint/search) ------------------------------

export const tavilyDefinition = defineRestPlugin({
  name: "web-search-tavily",
  version: VERSION,
  description: "Tavily search API (used by web-search)",
  baseUrl: "https://api.tavily.com",
  auth: { type: "bearer", env: KEY_ENV },
  // {"detail": {"error": "..."}}; 422 validation errors are {"detail": [{"loc", "msg", "type"}]}.
  errors: { messagePath: ["detail.error", "detail.0.msg", "error"], kindByStatus: { 432: "permission_denied", 433: "permission_denied" } },
  apiRequest: false,
  operations: [
    {
      name: "tavily_search",
      title: "Tavily search",
      description: "Search the web with Tavily",
      method: "POST",
      path: "/search",
      write: "unsafe",
      checkHint: "the search may have used credits; see the usage page of app.tavily.com before retrying",
      params: {
        query: { in: "body", type: "string", required: true, minLength: 1 },
        topic: { in: "body", type: "string", enum: ["general", "news", "finance"] },
        search_depth: { in: "body", type: "string", enum: ["basic", "advanced", "fast", "ultra-fast"] },
        max_results: { in: "body", type: "integer", min: 0, max: 20 },
        time_range: { in: "body", type: "string", enum: ["day", "week", "month", "year"] },
        include_answer: { in: "body", type: "boolean" },
        include_domains: listParam("Only these domains"),
        exclude_domains: listParam("Leave out these domains"),
      },
    },
  ],
});

// --- Brave Search (https://api-dashboard.search.brave.com/app/documentation) ----------------------------------

const braveParams = (maxCount) => ({
  q: { in: "query", type: "string", required: true, minLength: 1 },
  count: { in: "query", type: "integer", min: 1, max: maxCount },
  country: { in: "query", type: "string" },
  search_lang: { in: "query", type: "string" },
  freshness: { in: "query", type: "string" },
});
const BRAVE_CHECK_HINT = "the query may have been billed; see the usage page of api-dashboard.search.brave.com before retrying";

export const braveDefinition = defineRestPlugin({
  name: "web-search-brave",
  version: VERSION,
  description: "Brave Search API (used by web-search)",
  baseUrl: "https://api.search.brave.com/res/v1",
  auth: { type: "header", header: "X-Subscription-Token", env: KEY_ENV },
  // {"type": "ErrorResponse", "error": {"code": "SUBSCRIPTION_TOKEN_INVALID", "detail": "...", "status": 422}}
  errors: {
    messagePath: ["error.detail", "message"],
    codePath: "error.code",
    kindByCode: { SUBSCRIPTION_TOKEN_INVALID: "auth_error", SUBSCRIPTION_NOT_FOUND: "auth_error", RATE_LIMITED: "rate_limited", OPTION_NOT_IN_PLAN: "permission_denied" },
  },
  apiRequest: false,
  operations: [
    { name: "brave_web_search", title: "Brave web search", description: "Search the web with Brave", path: "/web/search", write: "unsafe", checkHint: BRAVE_CHECK_HINT, params: braveParams(20) },
    { name: "brave_news_search", title: "Brave news search", description: "Search news with Brave", path: "/news/search", write: "unsafe", checkHint: BRAVE_CHECK_HINT, params: braveParams(50) },
  ],
});

// --- SerpAPI (https://serpapi.com/search-api) --------------------------------------------------------------------

export const serpapiDefinition = defineRestPlugin({
  name: "web-search-serpapi",
  version: VERSION,
  description: "SerpAPI Google search (used by web-search)",
  baseUrl: "https://serpapi.com",
  auth: { type: "query", param: "api_key", env: KEY_ENV },
  // {"error": "Invalid API key. ..."}; "no results" also arrives as {"error"} with HTTP 200 (see normalizeSerpapi).
  errors: { messagePath: "error" },
  apiRequest: false,
  operations: [
    {
      name: "serpapi_google_search",
      title: "SerpAPI Google search",
      description: "Google results through SerpAPI",
      path: "/search.json",
      write: "unsafe",
      checkHint: "the search may have used one of your SerpAPI searches; see serpapi.com/searches before retrying",
      params: {
        q: { in: "query", type: "string", required: true, minLength: 1 },
        gl: { in: "query", type: "string" },
        hl: { in: "query", type: "string" },
        tbm: { in: "query", type: "string", enum: ["nws"] },
        tbs: { in: "query", type: "string" },
      },
      constants: { query: { engine: "google" } },
    },
  ],
});

// --- adapters --------------------------------------------------------------------------------------------------

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function buildResult({ title, url, snippet, publishedAt, source }) {
  return { title: title ?? null, url: url ?? null, snippet: snippet ?? null, published_at: publishedAt ?? null, source: source ?? hostnameOf(url) };
}

function normalizeTavily(body) {
  const results = (body?.results ?? []).map((item) => buildResult({ title: item.title, url: item.url, snippet: item.content, publishedAt: item.published_date }));
  return { answer: body?.answer ?? null, results };
}

function normalizeBrave(body, kind) {
  const items = kind === "news" ? body?.results : body?.web?.results;
  const results = (items ?? []).map((item) => buildResult({ title: item.title, url: item.url, snippet: item.description, publishedAt: item.page_age ?? item.age, source: item.meta_url?.hostname }));
  return { answer: null, results };
}

function normalizeSerpapi(body, kind) {
  if (typeof body?.error === "string" && !SERPAPI_NO_RESULTS.test(body.error)) {
    // Not retryable: a quota only refills with the next hour or billing period.
    const kind = SERPAPI_QUOTA_EXCEEDED.test(body.error) ? "rate_limited" : "api_error";
    throw new PluginError(`SerpAPI error: ${body.error}`, { kind, retryable: false });
  }
  const items = kind === "news" ? body?.news_results : body?.organic_results;
  const results = (items ?? []).map((item) =>
    buildResult({ title: item.title, url: item.link, snippet: item.snippet, publishedAt: item.date, source: typeof item.source === "object" ? item.source?.name : item.source }),
  );
  return { answer: null, results };
}

/**
 * Provider adapters: `definition`, `operationFor(kind)`, `buildArgs(kind, args)` and `normalize(body, kind)`, where
 * kind is "web" or "news" and args are the plugin's neutral arguments.
 */
export const PROVIDERS = {
  tavily: {
    definition: tavilyDefinition,
    operationFor: () => "tavily_search",
    buildArgs: (kind, args) => ({ query: args.query, topic: kind === "news" ? "news" : "general", max_results: args.max_results, time_range: args.freshness, include_answer: args.include_answer }),
    normalize: normalizeTavily,
  },
  brave: {
    definition: braveDefinition,
    operationFor: (kind) => (kind === "news" ? "brave_news_search" : "brave_web_search"),
    buildArgs: (kind, args) => ({ q: args.query, count: args.max_results, country: args.country?.toUpperCase(), search_lang: args.language?.toLowerCase(), freshness: BRAVE_FRESHNESS[args.freshness] }),
    normalize: normalizeBrave,
  },
  serpapi: {
    definition: serpapiDefinition,
    operationFor: () => "serpapi_google_search",
    buildArgs: (kind, args) => ({ q: args.query, gl: args.country?.toLowerCase(), hl: args.language?.toLowerCase(), tbm: kind === "news" ? "nws" : undefined, tbs: SERPAPI_FRESHNESS[args.freshness] }),
    normalize: (body, kind) => normalizeSerpapi(body, kind),
    // Google returns at most 10 results a page; SerpAPI has no page size any more.
    maxResults: 10,
  },
};
