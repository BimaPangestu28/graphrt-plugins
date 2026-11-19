import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://newsapi.org";
const article = { source: { id: null, name: "Example" }, title: "Rupiah steadies", url: "https://news.example.com/a" };

describeRestPluginContract(pluginDefinition, {
  operations: {
    search_articles: {
      args: { query: '"rupiah" AND bank', search_in: ["title", "description"], exclude_domains: ["spam.example.com"], from: "2026-11-01", language: "en", sort_by: "relevancy", limit: 10 },
      request: {
        method: "GET",
        url: `${API}/v2/everything`,
        query: { q: '"rupiah" AND bank', searchIn: "title,description", excludeDomains: "spam.example.com", from: "2026-11-01", language: "en", sortBy: "relevancy", pageSize: "10" },
      },
      response: { body: { status: "ok", totalResults: 1, articles: [article] } },
      expect: { data: [article] },
    },
    get_top_headlines: {
      args: { country: "id", category: "business" },
      request: { method: "GET", url: `${API}/v2/top-headlines`, query: { country: "id", category: "business", pageSize: "20" } },
    },
    list_sources: {
      args: { language: "en", category: "technology" },
      request: { method: "GET", url: `${API}/v2/top-headlines/sources`, query: { category: "technology", language: "en" } },
      response: { body: { status: "ok", sources: [{ id: "techcrunch", name: "TechCrunch" }] } },
      expect: { data: [{ id: "techcrunch", name: "TechCrunch" }] },
    },
  },
});

async function runHeadlines(response) {
  const recordingFetch = createRecordingFetch([response]);
  const run = createOperationRunner(pluginDefinition, { NEWSAPI_API_KEY: "news-key-0001" }, { fetchImpl: recordingFetch });
  return { promise: run("get_top_headlines", { country: "us" }, { source: "tool" }), calls: recordingFetch.calls };
}

test("the key goes in X-Api-Key, never in the URL", async () => {
  const { promise, calls } = await runHeadlines({ body: { status: "ok", articles: [] } });
  await promise;
  assert.equal(calls[0].headers["x-api-key"], "news-key-0001");
  assert.equal(new URL(calls[0].url).searchParams.has("apiKey"), false);
});

// 429 rateLimited is retried by the shared client, so it is not part of this single-response table.
test("NewsAPI error codes map to kinds", async () => {
  const cases = [
    [401, "apiKeyInvalid", "auth_error"],
    [400, "sourcesTooMany", "invalid_input"],
    [426, "parameterInvalid", "invalid_input"],
  ];
  for (const [status, code, kind] of cases) {
    const { promise } = await runHeadlines({ status, body: { status: "error", code, message: `NewsAPI says ${code}` } });
    await assert.rejects(promise, (error) => error.kind === kind && error.message.includes(`NewsAPI says ${code}`), code);
  }
});

test("the next page cursor follows page numbers", async () => {
  const recordingFetch = createRecordingFetch([{ body: { status: "ok", totalResults: 50, articles: [article, article] } }]);
  const run = createOperationRunner(pluginDefinition, { NEWSAPI_API_KEY: "k" }, { fetchImpl: recordingFetch });
  const result = await run("search_articles", { query: "rupiah", limit: 2 }, { source: "tool" });
  assert.ok(result.next_cursor);
});
