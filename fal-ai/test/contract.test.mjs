import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const QUEUE = "https://queue.fal.run";
const PLATFORM = "https://api.fal.ai/v1";
const REQUEST_ID = "764cabcf-b745-4b3e-ae38-1200304cf45b";

describeRestPluginContract(pluginDefinition, {
  // The generated download test serves its file from cdn.contract.example; real runs only allow *.fal.media.
  environment: { FAL_AI_EXTRA_DOWNLOAD_HOSTS: "cdn.contract.example" },
  operations: {
    run_model: {
      args: { model_id: "fal-ai/flux/dev", input: { prompt: "a red fox", num_images: 2 }, priority: "low" },
      request: { method: "POST", url: `${QUEUE}/fal-ai/flux/dev`, query: "absent", json: { prompt: "a red fox", num_images: 2 }, headers: { "x-fal-queue-priority": "low" } },
      response: { body: { status: "IN_QUEUE", queue_position: 0 } },
    },
    get_request_status: {
      args: { owner: "fal-ai", app: "flux", request_id: REQUEST_ID, logs: 1 },
      request: { method: "GET", url: `${QUEUE}/fal-ai/flux/requests/${REQUEST_ID}/status`, query: { logs: "1" } },
      response: { body: { status: "IN_PROGRESS" } },
      expect: { data: { status: "IN_PROGRESS" } },
    },
    get_request_result: {
      args: { owner: "fal-ai", app: "flux", request_id: REQUEST_ID },
      request: { method: "GET", url: `${QUEUE}/fal-ai/flux/requests/${REQUEST_ID}`, query: "absent" },
    },
    cancel_request: {
      args: { owner: "fal-ai", app: "flux", request_id: REQUEST_ID },
      request: { method: "PUT", url: `${QUEUE}/fal-ai/flux/requests/${REQUEST_ID}/cancel`, query: "absent", body: "absent" },
    },
    search_models: {
      args: { q: "flux", category: "text-to-image", endpoint_id: ["fal-ai/flux/dev", "fal-ai/flux/schnell"] },
      request: { method: "GET", url: `${PLATFORM}/models`, query: { q: "flux", category: "text-to-image", endpoint_id: ["fal-ai/flux/dev", "fal-ai/flux/schnell"] } },
      response: { body: { models: [{ endpoint_id: "fal-ai/flux/dev" }], next_cursor: null, has_more: false } },
      expect: { data: [{ endpoint_id: "fal-ai/flux/dev" }] },
    },
    get_pricing: {
      args: { endpoint_id: ["fal-ai/flux/dev"] },
      request: { method: "GET", url: `${PLATFORM}/models/pricing`, query: { endpoint_id: "fal-ai/flux/dev" } },
      response: { body: { prices: [{ endpoint_id: "fal-ai/flux/dev", unit_price: 0.025, unit: "megapixels", currency: "USD" }] } },
      expect: { data: [{ endpoint_id: "fal-ai/flux/dev", unit_price: 0.025, unit: "megapixels", currency: "USD" }] },
    },
    estimate_cost: {
      args: { estimate_type: "unit_price", endpoints: { "fal-ai/flux/dev": { unit_quantity: 50 } } },
      request: { method: "POST", url: `${PLATFORM}/models/pricing/estimate`, query: "absent", json: { estimate_type: "unit_price", endpoints: { "fal-ai/flux/dev": { unit_quantity: 50 } } } },
    },
  },
});

function createRunner(responses) {
  const outputDirectory = mkdtempSync(join(tmpdir(), "fal-ai-test-"));
  const recordingFetch = createRecordingFetch(responses);
  const environment = { FAL_KEY: "fal-test-not-real", FAL_AI_OUTPUT_DIR: outputDirectory, GRAPHRT_POLL_INTERVAL_MS: "0" };
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch, resolveHostAddresses: async () => ["93.184.216.34"] });
  return { run, calls: recordingFetch.calls, outputDirectory, cleanUp: () => rmSync(outputDirectory, { recursive: true, force: true }) };
}

const submitted = {
  request_id: REQUEST_ID,
  status_url: `${QUEUE}/fal-ai/flux/requests/${REQUEST_ID}/status`,
  response_url: `${QUEUE}/fal-ai/flux/requests/${REQUEST_ID}`,
  cancel_url: `${QUEUE}/fal-ai/flux/requests/${REQUEST_ID}/cancel`,
  queue_position: 0,
};

test("run_model sends `Authorization: Key`, polls status_url, fetches response_url and saves the images", async () => {
  const { run, calls, outputDirectory, cleanUp } = createRunner([
    { body: submitted },
    { status: 202, body: { status: "IN_QUEUE", queue_position: 1 } },
    { body: { status: "COMPLETED", metrics: { inference_time: 1.2 } } },
    { body: { images: [{ url: "https://v3.fal.media/files/fox.png", width: 1024 }], seed: 7 } },
    { body: "PNG-BYTES", headers: { "content-type": "image/png" } },
  ]);
  try {
    const { data } = await run("run_model", { model_id: "fal-ai/flux/dev", input: { prompt: "fox" } }, { source: "tool" });
    assert.equal(calls[0].headers.authorization, "Key fal-test-not-real");
    assert.equal(calls[1].url, submitted.status_url);
    assert.equal(calls[3].url, submitted.response_url);
    assert.equal(calls[4].headers.authorization, undefined, "media downloads carry no key");
    assert.equal(data.job_id, REQUEST_ID);
    assert.equal(data.result.seed, 7);
    assert.ok(data.saved_files[0].path.startsWith(outputDirectory));
    assert.equal(readFileSync(data.saved_files[0].path, "utf8"), "PNG-BYTES");
  } finally {
    cleanUp();
  }
});

test("an error returned by the result fetch names the request id and is not retryable", async () => {
  const { run, cleanUp } = createRunner([
    { body: submitted },
    { body: { status: "COMPLETED" } },
    { status: 422, body: { detail: [{ loc: ["body", "prompt"], msg: "field required", type: "value_error.missing" }] } },
  ]);
  await assert.rejects(run("run_model", { model_id: "fal-ai/flux/dev", input: {} }, { source: "tool" }), (error) => error.retryable === false && error.message.includes(REQUEST_ID) && error.message.includes("field required"));
  cleanUp();
});

test("a status_url outside queue.fal.run is refused", async () => {
  const { run, calls, cleanUp } = createRunner([{ body: { ...submitted, status_url: "https://evil.example/status" } }]);
  await assert.rejects(run("run_model", { model_id: "fal-ai/flux/dev", input: {} }, { source: "tool" }), (error) => error.retryable === false);
  assert.equal(calls.length, 1);
  cleanUp();
});

test("Platform API authorization_error maps to auth_error", async () => {
  const { run, cleanUp } = createRunner([{ status: 401, body: { error: { type: "authorization_error", message: "Invalid API key" } } }]);
  await assert.rejects(run("get_pricing", { endpoint_id: ["fal-ai/flux/dev"] }, { source: "tool" }), (error) => error.kind === "auth_error" && error.message.includes("Invalid API key"));
  cleanUp();
});

test("manifest has no api_request and declares the key and output directory", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.equal(manifest.nodes.some((node) => node.kind === "fal-ai.api_request"), false);
  assert.deepEqual(manifest.permissions.env.sort(), ["FAL_AI_EXTRA_DOWNLOAD_HOSTS", "FAL_AI_OUTPUT_DIR", "FAL_KEY"]);
});
