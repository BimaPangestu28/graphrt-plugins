/**
 * news-api plugin definition: NewsAPI.org v2 (https://newsapi.org/docs) to search articles from news sources and
 * blogs, read top headlines and list sources. Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * The key is sent in the X-Api-Key header (never in the URL). Errors are {"status": "error", "code": "...",
 * "message": "..."} with a 4xx status; `code` maps to the kind.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

const CATEGORIES = ["business", "entertainment", "general", "health", "science", "sports", "technology"];
const LANGUAGES = ["ar", "de", "en", "es", "fr", "he", "it", "nl", "no", "pt", "ru", "sv", "ud", "zh"];
const articlePagination = { dataPath: "articles", pagePagination: { pageParam: "page", sizeParam: "pageSize" }, maxLimit: 100, defaultLimit: 20 };
const listParam = (wireName, description) => ({ in: "query", type: "array", items: { type: "string" }, maxItems: 20, ...(wireName ? { wireName } : {}), description });
const queryParam = { in: "query", type: "string", wireName: "q", description: 'Keywords; "exact phrase", +must, -exclude, AND/OR/NOT and parentheses (max 500 chars)' };

const searchArticles = {
  name: "search_articles",
  title: "Search articles",
  description: "Search news articles and blog posts (title, description, url, source, author, publishedAt, content truncated to 200 chars)",
  path: "/v2/everything",
  params: {
    query: queryParam,
    search_in: { in: "query", type: "array", items: { type: "string", enum: ["title", "description", "content"] }, maxItems: 3, wireName: "searchIn", description: "Fields the query must match (default all)" },
    sources: listParam(undefined, "Source ids (max 20, see list_sources)"),
    domains: listParam(undefined, "Only these domains, e.g. [bbc.co.uk, techcrunch.com]"),
    exclude_domains: listParam("excludeDomains", "Leave out these domains"),
    from: { in: "query", type: "string", description: "Oldest article, ISO 8601 date or date-time, e.g. 2026-11-01" },
    to: { in: "query", type: "string", description: "Newest article, ISO 8601 date or date-time" },
    language: { in: "query", type: "string", enum: LANGUAGES, description: "Article language (default all)" },
    sort_by: { in: "query", type: "string", enum: ["relevancy", "popularity", "publishedAt"], wireName: "sortBy", description: "Order (default publishedAt)" },
  },
  response: articlePagination,
};

const getTopHeadlines = {
  name: "get_top_headlines",
  title: "Top headlines",
  description: "Breaking headlines by country, category, source or keyword (sources cannot be combined with country or category)",
  path: "/v2/top-headlines",
  params: {
    country: { in: "query", type: "string", description: "2-letter country code, e.g. us, id, gb" },
    category: { in: "query", type: "string", enum: CATEGORIES, description: "News category" },
    sources: listParam(undefined, "Source ids (not with country or category)"),
    query: queryParam,
  },
  response: articlePagination,
};

const listSources = {
  name: "list_sources",
  title: "List news sources",
  description: "Sources that publish top headlines: id, name, description, url, category, language, country",
  path: "/v2/top-headlines/sources",
  params: {
    category: { in: "query", type: "string", enum: CATEGORIES, description: "Only this category" },
    language: { in: "query", type: "string", enum: LANGUAGES, description: "Only this language" },
    country: { in: "query", type: "string", description: "Only this 2-letter country code" },
  },
  response: { dataPath: "sources" },
};

export const pluginDefinition = defineRestPlugin({
  name: "news-api",
  version: "0.1.0",
  description: "NewsAPI.org: search news articles and blogs, top headlines by country or category, and news sources",
  apiName: "NewsAPI",
  baseUrl: "https://newsapi.org",
  auth: { type: "header", header: "X-Api-Key", env: "NEWSAPI_API_KEY" },
  errors: {
    messagePath: "message",
    codePath: "code",
    kindByCode: {
      apiKeyDisabled: "auth_error",
      apiKeyExhausted: "rate_limited",
      apiKeyInvalid: "auth_error",
      apiKeyMissing: "auth_error",
      parameterInvalid: "invalid_input",
      parametersMissing: "invalid_input",
      parametersIncompatible: "invalid_input",
      rateLimited: "rate_limited",
      sourcesTooMany: "invalid_input",
      sourceDoesNotExist: "not_found",
      maximumResultsReached: "invalid_input",
    },
  },
  apiRequest: { examplePath: "/v2/top-headlines?country=us" },
  operations: [searchArticles, getTopHeadlines, listSources],
});
