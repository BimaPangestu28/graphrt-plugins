import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition, restDefinition, USER_AGENT } from "../definition.mjs";

const WIKI = "https://en.wikipedia.org";
const ACTION_QUERY = { action: "query", format: "json", formatversion: "2" };

describeRestPluginContract(restDefinition, {
  operations: {
    search_pages: {
      args: { query: "Borobudur", limit: 5 },
      request: { method: "GET", url: `${WIKI}/w/api.php`, query: { ...ACTION_QUERY, list: "search", srsearch: "Borobudur", srlimit: "5" } },
      response: { body: { query: { searchinfo: { totalhits: 2 }, search: [{ title: "Borobudur", pageid: 233717 }] } } },
      expect: { data: [{ title: "Borobudur", pageid: 233717 }] },
    },
    get_page_summary: {
      args: { page_title: "AC/DC" },
      request: { method: "GET", url: `${WIKI}/api/rest_v1/page/summary/AC%2FDC`, query: "absent" },
      response: { body: { title: "AC/DC", extract: "AC/DC are an Australian rock band." } },
      expect: { data: { title: "AC/DC", extract: "AC/DC are an Australian rock band." } },
    },
    get_page_content: {
      args: { page_title: "Borobudur", intro_only: true },
      request: { method: "GET", url: `${WIKI}/w/api.php`, query: { ...ACTION_QUERY, prop: "extracts", explaintext: "1", redirects: "1", titles: "Borobudur", exintro: "true" } },
      response: { body: { query: { pages: [{ pageid: 233717, title: "Borobudur", extract: "Borobudur is a temple." }] } } },
      expect: { data: { pageid: 233717, title: "Borobudur", extract: "Borobudur is a temple." } },
    },
    get_page_media: {
      args: { page_title: "Borobudur" },
      request: { method: "GET", url: `${WIKI}/api/rest_v1/page/media-list/Borobudur`, query: "absent" },
      response: { body: { revision: "1", items: [{ title: "File:Pradaksina.jpg", type: "image" }] } },
      expect: { data: [{ title: "File:Pradaksina.jpg", type: "image" }] },
    },
    search_nearby_pages: {
      args: { coordinates: "-7.6079|110.2038", radius_meters: 5000, limit: 3 },
      request: { method: "GET", url: `${WIKI}/w/api.php`, query: { ...ACTION_QUERY, list: "geosearch", gscoord: "-7.6079|110.2038", gsradius: "5000", gslimit: "3" } },
      response: { body: { query: { geosearch: [{ title: "Borobudur", dist: 24.7 }] } } },
      expect: { data: [{ title: "Borobudur", dist: 24.7 }] },
    },
    get_page_languages: {
      args: { page_title: "Borobudur", limit: 2 },
      request: { method: "GET", url: `${WIKI}/w/api.php`, query: { ...ACTION_QUERY, prop: "langlinks", llprop: "url", redirects: "1", titles: "Borobudur", lllimit: "2" } },
      response: { body: { query: { pages: [{ title: "Borobudur", langlinks: [{ lang: "id", title: "Borobudur", url: "https://id.wikipedia.org/wiki/Borobudur" }] }] } } },
      expect: { data: { title: "Borobudur", langlinks: [{ lang: "id", title: "Borobudur", url: "https://id.wikipedia.org/wiki/Borobudur" }] } },
    },
  },
});

async function runOperation(operationName, args, responses, environment = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  return { result: await run(operationName, args, { source: "tool" }), calls: recordingFetch.calls };
}

test("wikipedia needs no credential and every operation takes a language", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions, { network: true, secrets: false, env: ["WIKIPEDIA_LANGUAGE"] });
  for (const tool of manifest.tools.filter((descriptor) => descriptor.name !== "api_request")) assert.ok(tool.parameters.properties.language, tool.name);
});

test("every request carries the descriptive User-Agent Wikimedia asks for", async () => {
  const { calls } = await runOperation("get_page_summary", { page_title: "Borobudur" }, [{ body: {} }]);
  assert.equal(calls[0].headers["user-agent"], USER_AGENT);
  assert.match(USER_AGENT, /^graphrt-wikipedia-plugin\/\d+\.\d+\.\d+ \(https:\/\/github\.com\//);
});

test("language picks that Wikipedia's host for the call", async () => {
  const { calls } = await runOperation("get_page_summary", { page_title: "Candi Borobudur", language: "id" }, [{ body: {} }]);
  assert.equal(calls[0].url, "https://id.wikipedia.org/api/rest_v1/page/summary/Candi%20Borobudur");
});

test("WIKIPEDIA_LANGUAGE sets the default host", async () => {
  const { calls } = await runOperation("search_pages", { query: "Borobudur" }, [{ body: { query: { search: [] } } }], { WIKIPEDIA_LANGUAGE: "de" });
  assert.equal(new URL(calls[0].url).origin, "https://de.wikipedia.org");
});

test("a language that is not a plain wiki code is refused before any request", async () => {
  for (const language of ["evil.example.com/x", "en.m", "EN", "a"]) {
    const recordingFetch = createRecordingFetch([]);
    const run = createOperationRunner(pluginDefinition, {}, { fetchImpl: recordingFetch });
    await assert.rejects(run("get_page_summary", { page_title: "X", language }, { source: "tool" }), (error) => error.kind === "invalid_input", language);
    assert.equal(recordingFetch.calls.length, 0);
  }
  const run = createOperationRunner(pluginDefinition, { WIKIPEDIA_LANGUAGE: "evil.com#" }, { fetchImpl: createRecordingFetch([]) });
  await assert.rejects(run("get_page_summary", { page_title: "X" }, { source: "tool" }), (error) => error.kind === "invalid_input");
});

test("get_page_content caps the plain text at max_chars and says so", async () => {
  const extract = "a".repeat(30);
  const { result } = await runOperation("get_page_content", { page_title: "X", max_chars: 10 }, [{ body: { query: { pages: [{ title: "X", extract }] } } }]);
  assert.deepEqual(result.data, { title: "X", extract: "a".repeat(10), truncated: true, total_chars: 30 });
});

test("get_page_content leaves a short text untouched and reports a missing page", async () => {
  const { result } = await runOperation("get_page_content", { page_title: "X" }, [{ body: { query: { pages: [{ title: "X", extract: "short" }] } } }]);
  assert.deepEqual(result.data, { title: "X", extract: "short", truncated: false, total_chars: 5 });
  await assert.rejects(
    runOperation("get_page_content", { page_title: "Nope" }, [{ body: { query: { pages: [{ title: "Nope", missing: true }] } } }]),
    (error) => error.kind === "not_found" && error.message.includes("Nope"),
  );
});

test("a MediaWiki {error: {code, info}} answer (HTTP 200) becomes an error with the info", async () => {
  await assert.rejects(
    runOperation("search_pages", { query: "x" }, [{ body: { error: { code: "badvalue", info: "Unrecognized value for parameter \"list\"" } } }]),
    (error) => error.kind === "invalid_input" && error.message.includes("Unrecognized value") && error.message.includes("badvalue"),
  );
});

test("a REST 404 for an unknown page is not_found", async () => {
  await assert.rejects(
    runOperation("get_page_summary", { page_title: "Zzzz" }, [{ status: 404, body: { status: 404, type: "https://mediawiki.org/wiki/HyperSwitch/errors/not_found", title: "Not found.", detail: "Page or revision not found." } }]),
    (error) => error.kind === "not_found",
  );
});

test("get_page_languages returns llcontinue as next_cursor and sends it back", async () => {
  const firstBody = { continue: { llcontinue: "233717|arz", continue: "||" }, query: { pages: [{ title: "Borobudur", langlinks: [{ lang: "ar" }] }] } };
  const { result } = await runOperation("get_page_languages", { page_title: "Borobudur", limit: 1 }, [{ body: firstBody }]);
  assert.ok(result.next_cursor);
  const lastBody = { query: { pages: [{ title: "Borobudur", langlinks: [{ lang: "zh" }] }] } };
  const { result: lastResult, calls } = await runOperation("get_page_languages", { page_title: "Borobudur", limit: 1, cursor: result.next_cursor }, [{ body: lastBody }]);
  assert.equal(new URL(calls[0].url).searchParams.get("llcontinue"), "233717|arz");
  assert.equal(lastResult.next_cursor, null);
});
