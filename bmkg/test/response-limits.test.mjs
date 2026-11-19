import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createCappedFetch, MAX_RESPONSE_BYTES } from "../lib/bmkg-results.mjs";
import { pluginDefinition } from "../definition.mjs";

function streamedResponse(totalBytes, { chunkBytes = 64 * 1024, headers = {} } = {}) {
  let sentBytes = 0;
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (sentBytes >= totalBytes) return controller.close();
      const size = Math.min(chunkBytes, totalBytes - sentBytes);
      sentBytes += size;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
  return { response: new Response(body, { status: 200, headers }), pulls: () => pulls };
}

async function runWithFetch(fetchImpl, operationName, args) {
  const runner = createOperationRunner(pluginDefinition, {}, { fetchImpl });
  return runner(operationName, args, { source: "tool" });
}

test("MAX_RESPONSE_BYTES is about 2 MB", () => {
  assert.equal(MAX_RESPONSE_BYTES, 2 * 1024 * 1024);
});

test("createCappedFetch passes small bodies through with status and headers", async () => {
  const cappedFetch = createCappedFetch(async () => new Response("<rss/>", { status: 200, headers: { "content-type": "application/xml" } }), 100);
  const response = await cappedFetch("https://www.bmkg.go.id/alerts/nowcast/id");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/xml");
  assert.equal(await response.text(), "<rss/>");
});

test("createCappedFetch stops reading a streamed body past the cap and answers 413", async () => {
  const streamed = streamedResponse(10 * 1024 * 1024);
  const cappedFetch = createCappedFetch(async () => streamed.response, 256 * 1024);
  const response = await cappedFetch("https://data.bmkg.go.id/x.json");
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /larger than 262144 bytes/);
  assert.ok(streamed.pulls() < 10, `read ${streamed.pulls()} chunks`);
});

test("createCappedFetch refuses a declared Content-Length over the cap without reading", async () => {
  const streamed = streamedResponse(1024, { headers: { "content-length": String(5 * 1024 * 1024) } });
  const cappedFetch = createCappedFetch(async () => streamed.response, 1024 * 1024);
  const response = await cappedFetch("https://data.bmkg.go.id/x.json");
  assert.equal(response.status, 413);
});

test("an oversized BMKG response is a non-retryable api_error, fetched once, never parsed", async () => {
  let calls = 0;
  const hugeFetch = async () => {
    calls += 1;
    return streamedResponse(MAX_RESPONSE_BYTES + 1).response;
  };
  await assert.rejects(runWithFetch(hugeFetch, "list_weather_warnings", { language: "id" }), (error) => error.kind === "api_error" && error.retryable === false && /2097152 bytes/.test(error.message));
  assert.equal(calls, 1);
});

test("api_request is capped too", async () => {
  const hugeFetch = async () => streamedResponse(MAX_RESPONSE_BYTES + 1).response;
  await assert.rejects(runWithFetch(hugeFetch, "api_request", { path: "/DataMKG/TEWS/autogempa.json" }), (error) => error.kind === "api_error");
});

test("get_weather_warning refuses alert codes that are not letters and digits, before any request", async () => {
  const recordingFetch = createRecordingFetch([]);
  for (const alertCode of ["CNB2026/../x", "CNB 1", "", "CNB_1", "..", "CNB%2F1"]) {
    await assert.rejects(runWithFetch(recordingFetch, "get_weather_warning", { language: "id", alert_code: alertCode }), (error) => error.kind === "invalid_input");
  }
  assert.equal(recordingFetch.calls.length, 0);
});

test("get_weather_warning accepts a normal alert code", async () => {
  const recordingFetch = createRecordingFetch([{ body: "<alert><info><event>Hujan</event></info></alert>", headers: { "content-type": "application/xml" } }]);
  await runWithFetch(recordingFetch, "get_weather_warning", { language: "id", alert_code: "CNB20261119002" });
  assert.equal(recordingFetch.calls[0].url, "https://www.bmkg.go.id/alerts/nowcast/id/CNB20261119002_alert.xml");
});
