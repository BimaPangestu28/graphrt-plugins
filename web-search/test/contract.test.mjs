import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { braveDefinition, pluginDefinition, serpapiDefinition, tavilyDefinition } from "../definition.mjs";

// --- provider contracts --------------------------------------------------------------------------------------

describeRestPluginContract(tavilyDefinition, {
  operations: {
    tavily_search: {
      args: { query: "rupiah exchange rate", topic: "news", max_results: 5, time_range: "week", include_answer: true },
      request: { method: "POST", url: "https://api.tavily.com/search", query: "absent", json: { query: "rupiah exchange rate", topic: "news", max_results: 5, time_range: "week", include_answer: true } },
      response: { body: { query: "rupiah exchange rate", answer: "About 18,200 per USD.", results: [{ title: "Rupiah", url: "https://news.example.com/r", content: "..." }] } },
      expect: { data: { query: "rupiah exchange rate", answer: "About 18,200 per USD.", results: [{ title: "Rupiah", url: "https://news.example.com/r", content: "..." }] } },
    },
  },
});

describeRestPluginContract(braveDefinition, {
  operations: {
    brave_web_search: {
      args: { q: "borobudur opening hours", count: 5, country: "ID", search_lang: "en", freshness: "pm" },
      request: { method: "GET", url: "https://api.search.brave.com/res/v1/web/search", query: { q: "borobudur opening hours", count: "5", country: "ID", search_lang: "en", freshness: "pm" } },
    },
    brave_news_search: {
      args: { q: "bank indonesia", count: 10 },
      request: { method: "GET", url: "https://api.search.brave.com/res/v1/news/search", query: { q: "bank indonesia", count: "10" } },
    },
  },
});

describeRestPluginContract(serpapiDefinition, {
  operations: {
    serpapi_google_search: {
      args: { q: "bank indonesia", gl: "id", hl: "en", tbm: "nws", tbs: "qdr:w" },
      request: { method: "GET", url: "https://serpapi.com/search.json", query: { engine: "google", q: "bank indonesia", gl: "id", hl: "en", tbm: "nws", tbs: "qdr:w" } },
    },
  },
});

// --- unified operations --------------------------------------------------------------------------------------

const KEY = "search-key-0001";

async function runSearch(provider, operationName, args, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const environment = { WEB_SEARCH_PROVIDER: provider, WEB_SEARCH_API_KEY: KEY };
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  return { result: await run(operationName, args, { source: "tool" }), calls: recordingFetch.calls };
}

test("tavily: search sends a bearer key and returns normalized results with the answer", async () => {
  const body = { answer: "Yes.", results: [{ title: "T", url: "https://a.example/1", content: "snippet", published_date: "2026-11-18" }] };
  const { result, calls } = await runSearch("tavily", "search", { query: "q", max_results: 3, freshness: "day" }, [{ body }]);
  assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(calls[0].body), { query: "q", topic: "general", max_results: 3, time_range: "day", include_answer: true });
  assert.deepEqual(result.data, {
    provider: "tavily",
    query: "q",
    answer: "Yes.",
    results: [{ title: "T", url: "https://a.example/1", snippet: "snippet", published_at: "2026-11-18", source: "a.example" }],
  });
});

test("tavily: search_news uses topic news", async () => {
  const { calls } = await runSearch("tavily", "search_news", { query: "q" }, [{ body: { results: [] } }]);
  assert.equal(JSON.parse(calls[0].body).topic, "news");
});

test("brave: search maps country, language and freshness and reads web.results", async () => {
  const body = { web: { results: [{ title: "B", url: "https://b.example/x", description: "desc", page_age: "2026-11-01T00:00:00", meta_url: { hostname: "b.example" } }] } };
  const { result, calls } = await runSearch("brave", "search", { query: "q", max_results: 4, country: "id", language: "en", freshness: "week" }, [{ body }]);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/res/v1/web/search");
  assert.deepEqual(Object.fromEntries(url.searchParams), { q: "q", count: "4", country: "ID", search_lang: "en", freshness: "pw" });
  assert.equal(calls[0].headers["x-subscription-token"], KEY);
  assert.deepEqual(result.data.results, [{ title: "B", url: "https://b.example/x", snippet: "desc", published_at: "2026-11-01T00:00:00", source: "b.example" }]);
});

test("brave: search_news calls the news endpoint and reads results", async () => {
  const body = { results: [{ title: "N", url: "https://n.example/1", description: "d", age: "2 hours ago", meta_url: { hostname: "n.example" } }] };
  const { result, calls } = await runSearch("brave", "search_news", { query: "q" }, [{ body }]);
  assert.equal(new URL(calls[0].url).pathname, "/res/v1/news/search");
  assert.deepEqual(result.data.results, [{ title: "N", url: "https://n.example/1", snippet: "d", published_at: "2 hours ago", source: "n.example" }]);
});

test("serpapi: search sends api_key in the query and trims to max_results", async () => {
  const organic = [1, 2, 3].map((index) => ({ title: `S${index}`, link: `https://s.example/${index}`, snippet: "s", source: "S" }));
  const { result, calls } = await runSearch("serpapi", "search", { query: "q", max_results: 2, country: "ID", language: "id", freshness: "month" }, [{ body: { organic_results: organic } }]);
  const params = Object.fromEntries(new URL(calls[0].url).searchParams);
  assert.deepEqual(params, { engine: "google", q: "q", gl: "id", hl: "id", tbs: "qdr:m", api_key: KEY });
  assert.deepEqual(result.data.results.map((item) => item.url), ["https://s.example/1", "https://s.example/2"]);
});

test("serpapi: search_news uses tbm=nws and reads news_results", async () => {
  const body = { news_results: [{ title: "G", link: "https://g.example/1", snippet: "g", date: "1 day ago", source: "G News" }] };
  const { result, calls } = await runSearch("serpapi", "search_news", { query: "q" }, [{ body }]);
  assert.equal(new URL(calls[0].url).searchParams.get("tbm"), "nws");
  assert.deepEqual(result.data.results, [{ title: "G", url: "https://g.example/1", snippet: "g", published_at: "1 day ago", source: "G News" }]);
});

test("serpapi: 'no results' is an empty list, other in-body errors fail", async () => {
  const { result } = await runSearch("serpapi", "search", { query: "zzqq" }, [{ body: { error: "Google hasn't returned any results for this query." } }]);
  assert.deepEqual(result.data.results, []);
  await assert.rejects(runSearch("serpapi", "search", { query: "q" }, [{ body: { error: "Unsupported `gl` parameter." } }]), (error) => error.kind === "api_error" && error.message.includes("Unsupported"));
});

test("serpapi: quota errors in a 200 body are rate_limited and not retryable", async () => {
  const quotaMessages = [
    "Your account has run out of searches.",
    "Your searches for the month are exhausted. You can upgrade plans on SerpApi.com website.",
    "You have exceeded the hourly throughput limit for your plan.",
  ];
  for (const message of quotaMessages) {
    await assert.rejects(
      runSearch("serpapi", "search_news", { query: "q" }, [{ body: { error: message } }]),
      (error) => error.kind === "rate_limited" && error.retryable === false && error.message.includes(message),
      message,
    );
  }
});

test("a missing or unknown provider is refused before any request", async () => {
  for (const provider of [undefined, "bing"]) {
    const recordingFetch = createRecordingFetch([]);
    const environment = { WEB_SEARCH_API_KEY: KEY, ...(provider ? { WEB_SEARCH_PROVIDER: provider } : {}) };
    const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
    await assert.rejects(run("search", { query: "q" }, { source: "tool" }), (error) => error.kind === "invalid_input" && error.message.includes("WEB_SEARCH_PROVIDER"));
    assert.equal(recordingFetch.calls.length, 0);
  }
});

test("a missing key is an auth_error", async () => {
  const run = createOperationRunner(pluginDefinition, { WEB_SEARCH_PROVIDER: "brave" }, { fetchImpl: createRecordingFetch([]) });
  await assert.rejects(run("search", { query: "q" }, { source: "tool" }), (error) => error.kind === "auth_error");
});

test("paid searches are never retried after a 5xx, and the error says how to check", async () => {
  const failures = [{ status: 502, body: { detail: { error: "bad gateway" } } }, { status: 200, body: { results: [] } }];
  const recordingFetch = createRecordingFetch(failures);
  const run = createOperationRunner(pluginDefinition, { WEB_SEARCH_PROVIDER: "tavily", WEB_SEARCH_API_KEY: KEY }, { fetchImpl: recordingFetch });
  await assert.rejects(run("search", { query: "q" }, { source: "tool" }), (error) => error.retryable === false && /usage/.test(error.message));
  assert.equal(recordingFetch.calls.length, 1);
});

test("provider auth errors are auth_error (Brave answers 422 with SUBSCRIPTION_TOKEN_INVALID)", async () => {
  const braveInvalid = { status: 422, body: { type: "ErrorResponse", error: { code: "SUBSCRIPTION_TOKEN_INVALID", detail: "The provided subscription token is invalid.", status: 422 } } };
  await assert.rejects(runSearch("brave", "search", { query: "q" }, [braveInvalid]), (error) => error.kind === "auth_error" && error.message.includes("subscription token is invalid"));
  const tavilyInvalid = { status: 401, body: { detail: { error: "Unauthorized: missing or invalid API key." } } };
  await assert.rejects(runSearch("tavily", "search", { query: "q" }, [tavilyInvalid]), (error) => error.kind === "auth_error" && error.message.includes("invalid API key"));
});

test("the key is redacted from results and errors", async () => {
  const { result } = await runSearch("tavily", "search", { query: "q" }, [{ body: { results: [{ title: KEY, url: "https://a.example/1", content: `echo ${KEY}` }] } }]);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test("manifest: two tools, key and provider from env", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["search", "search_news"]);
  assert.deepEqual(manifest.permissions.env, ["WEB_SEARCH_API_KEY", "WEB_SEARCH_PROVIDER"]);
});
