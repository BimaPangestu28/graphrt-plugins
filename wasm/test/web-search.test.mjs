/**
 * web-search: the Node.js plugin and its WebAssembly build (wasm/web-search) agree on every case, for each provider.
 */
import { fileURLToPath } from "node:url";
import * as operationsModule from "../../web-search/lib/shared/operations.mjs";
import { pluginDefinition } from "../../web-search/definition.mjs";
import { defineParitySuite } from "./rest-parity.mjs";

const KEY = "test-key/with+chars=0123456789";
const TAVILY = { answer: "Borobudur is in Magelang.", results: [{ title: "Borobudur", url: "https://EN.Wikipedia.org/wiki/Borobudur", content: "A temple", published_date: "2026-01-01" }, { title: "No URL" }] };
const BRAVE_WEB = { web: { results: [{ title: "Borobudur", url: "https://unesco.org/x", description: "World heritage", page_age: "2025-01-01", meta_url: { hostname: "whc.unesco.org" } }, { title: "Age only", url: "not a url", age: "2 days ago" }] } };
const BRAVE_NEWS = { results: Array.from({ length: 25 }, (_, index) => ({ title: `News ${index}`, url: `https://news.example/${index}` })) };
const SERPAPI = { organic_results: [{ title: "Borobudur", link: "https://id.wikipedia.org/wiki/Borobudur", snippet: "Candi", source: "Wikipedia" }], news_results: [{ title: "N", link: "https://n.example/a", source: { name: "Kompas" }, date: "1 hour ago" }] };

const tavily = { WEB_SEARCH_PROVIDER: "tavily", WEB_SEARCH_API_KEY: KEY };
const brave = { WEB_SEARCH_PROVIDER: " Brave ", WEB_SEARCH_API_KEY: KEY };
const serpapi = { WEB_SEARCH_PROVIDER: "serpapi", WEB_SEARCH_API_KEY: KEY };

const CASES = [
  { name: "tavily web search", operation: "search", env: tavily, args: { query: "where is borobudur", max_results: 5, freshness: "week" }, responses: [{ body: TAVILY }] },
  { name: "tavily news without answer", operation: "search_news", env: tavily, args: { query: "borobudur", include_answer: "false" }, responses: [{ body: { results: [] } }] },
  { name: "tavily invalid key", operation: "search", env: tavily, args: { query: "x" }, responses: [{ status: 401, body: { detail: { error: "Unauthorized: missing or invalid API key." } } }], kind: "auth_error" },
  { name: "tavily usage limit (432)", operation: "search", env: tavily, args: { query: "x" }, responses: [{ status: 432, body: { detail: { error: `This request exceeds your plan's set usage limit for key ${KEY}` } } }], kind: "permission_denied", message: /\[redacted\]/ },
  { name: "tavily validation error (422)", operation: "search", env: tavily, args: { query: "x" }, responses: [{ status: 422, body: { detail: [{ loc: ["body", "query"], msg: "field required", type: "missing" }] } }], kind: "invalid_input" },
  { name: "tavily server error is not retried (paid call)", operation: "search", env: tavily, args: { query: "x" }, responses: [{ status: 500, body: { detail: { error: "Internal error" } } }], kind: "api_error", message: /To check: / },
  { name: "tavily timeout is not retried", operation: "search", env: tavily, args: { query: "x" }, transport: "timeout", kind: "network_error", message: /outcome unknown/ },
  { name: "tavily rate limited", operation: "search", env: tavily, args: { query: "x" }, responses: Array.from({ length: 3 }, () => ({ status: 429, body: { detail: { error: "Rate limit" } } })), kind: "rate_limited", rateLimited: true },
  { name: "brave web search", operation: "search", env: brave, args: { query: "borobudur", country: "id", language: "EN", freshness: "month", max_results: "3" }, responses: [{ body: BRAVE_WEB }] },
  { name: "brave news, results capped at max_results", operation: "search_news", env: brave, args: { query: "jakarta", max_results: 20 }, responses: [{ body: BRAVE_NEWS }] },
  { name: "brave invalid token", operation: "search", env: brave, args: { query: "x" }, responses: [{ status: 422, body: { type: "ErrorResponse", error: { code: "SUBSCRIPTION_TOKEN_INVALID", detail: "The provided subscription token is invalid.", status: 422 } } }], kind: "auth_error", message: /SUBSCRIPTION_TOKEN_INVALID/ },
  { name: "brave key echoed in the body is redacted", operation: "search", env: brave, args: { query: "x" }, responses: [{ body: { web: { results: [{ title: `token ${KEY}`, url: `https://x.example/?k=${encodeURIComponent(KEY)}` }] } } }] },
  { name: "serpapi google search", operation: "search", env: serpapi, args: { query: "candi borobudur", country: "ID", language: "id", max_results: 15 }, responses: [{ body: SERPAPI }] },
  { name: "serpapi news", operation: "search_news", env: serpapi, args: { query: "berita", freshness: "day" }, responses: [{ body: SERPAPI }] },
  { name: "serpapi no results is empty", operation: "search", env: serpapi, args: { query: "zzqx" }, responses: [{ body: { error: "Google hasn't returned any results for this query." } }] },
  { name: "serpapi quota in a 200", operation: "search", env: serpapi, args: { query: "x" }, responses: [{ body: { error: "Your account has run out of searches." } }], kind: "rate_limited" },
  { name: "serpapi other error in a 200", operation: "search", env: serpapi, args: { query: "x" }, responses: [{ body: { error: "Invalid API key. Your API key should be here." } }], kind: "api_error" },
  { name: "serpapi invalid key (401)", operation: "search", env: serpapi, args: { query: "x" }, responses: [{ status: 401, body: { error: "Invalid API key." } }], kind: "auth_error" },
  { name: "serpapi connection refused", operation: "search", env: serpapi, args: { query: "x" }, transport: "refused", kind: "network_error", sameMessage: false },
  { name: "no provider", operation: "search", env: { WEB_SEARCH_API_KEY: KEY }, args: { query: "x" }, kind: "invalid_input", message: /WEB_SEARCH_PROVIDER/ },
  { name: "unknown provider", operation: "search", env: { WEB_SEARCH_PROVIDER: "Bing", WEB_SEARCH_API_KEY: KEY }, args: { query: "x" }, kind: "invalid_input", message: /got "bing"/ },
  { name: "no key", operation: "search", env: { WEB_SEARCH_PROVIDER: "brave" }, args: { query: "x" }, kind: "auth_error", message: /WEB_SEARCH_API_KEY/ },
  { name: "query required", operation: "search", env: brave, args: {}, kind: "invalid_input" },
  { name: "bad freshness", operation: "search", env: brave, args: { query: "x", freshness: "hour" }, kind: "invalid_input" },
  { name: "a node's access_token wins", operation: "search", env: brave, args: { query: "x", access_token: " node-token-123 " }, sources: ["node"], responses: [{ body: BRAVE_WEB }] },
  { name: "a masked node access_token", operation: "search", env: brave, args: { query: "x", access_token: "******" }, sources: ["node"], kind: "auth_error", message: /--trust-plugin web-search/ },
  { name: "a tool cannot pass access_token", operation: "search", env: { WEB_SEARCH_PROVIDER: "brave" }, args: { query: "x", access_token: "abcd" }, sources: ["tool"], kind: "auth_error" },
];

defineParitySuite({
  pluginName: "web-search",
  pluginDefinition,
  operationsModule,
  wasmPath: fileURLToPath(new URL("../web-search/web_search.wasm", import.meta.url)),
  cases: CASES,
});
