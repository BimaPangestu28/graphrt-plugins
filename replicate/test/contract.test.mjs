import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.replicate.com/v1";
const VERSION_ID = "5c7d5dc6dd8bf75c1acaa8565735e7986bc5b66206b55cca93cb72c9bf15ccaa";

describeRestPluginContract(pluginDefinition, {
  // The generated download test serves its file from cdn.contract.example; real runs only allow replicate.delivery.
  environment: { REPLICATE_EXTRA_DOWNLOAD_HOSTS: "cdn.contract.example" },
  operations: {
    get_account: { args: {}, request: { method: "GET", url: `${API}/account`, query: "absent" }, response: { body: { type: "user", username: "alice" } }, expect: { data: { type: "user", username: "alice" } } },
    search: { args: { query: "upscale image", limit: 5 }, request: { method: "GET", url: `${API}/search`, query: { query: "upscale image", limit: "5" } } },
    list_models: { args: { sort_by: "model_created_at" }, request: { method: "GET", url: `${API}/models`, query: { sort_by: "model_created_at" } }, response: { body: { next: null, results: [{ owner: "a", name: "b" }] } }, expect: { data: [{ owner: "a", name: "b" }] } },
    get_model: { args: { model_owner: "black-forest-labs", model_name: "flux-schnell" }, request: { method: "GET", url: `${API}/models/black-forest-labs/flux-schnell`, query: "absent" } },
    list_model_versions: { args: { model_owner: "stability-ai", model_name: "sdxl" }, request: { method: "GET", url: `${API}/models/stability-ai/sdxl/versions`, query: "absent" } },
    get_model_version: { args: { model_owner: "stability-ai", model_name: "sdxl", version_id: VERSION_ID }, request: { method: "GET", url: `${API}/models/stability-ai/sdxl/versions/${VERSION_ID}`, query: "absent" } },
    list_collections: { args: {}, request: { method: "GET", url: `${API}/collections`, query: "absent" } },
    get_collection: { args: { collection_slug: "text-to-image" }, request: { method: "GET", url: `${API}/collections/text-to-image`, query: "absent" } },
    list_hardware: { args: {}, request: { method: "GET", url: `${API}/hardware`, query: "absent" } },
    run_model: {
      args: { model_owner: "black-forest-labs", model_name: "flux-schnell", input: { prompt: "a red fox", num_outputs: 2 }, cancel_after: "5m" },
      request: { method: "POST", url: `${API}/models/black-forest-labs/flux-schnell/predictions`, query: "absent", json: { input: { prompt: "a red fox", num_outputs: 2 } }, headers: { "cancel-after": "5m" } },
      response: { body: { status: "starting" } },
    },
    create_prediction: {
      args: { version: VERSION_ID, input: { prompt: "a castle" } },
      request: { method: "POST", url: `${API}/predictions`, query: "absent", json: { version: VERSION_ID, input: { prompt: "a castle" } } },
    },
    run_deployment: {
      args: { deployment_owner: "acme", deployment_name: "my-sdxl", input: { prompt: "a cat" } },
      request: { method: "POST", url: `${API}/deployments/acme/my-sdxl/predictions`, query: "absent", json: { input: { prompt: "a cat" } } },
    },
    get_prediction: { args: { prediction_id: "gm3qorzdhgbfurvjtvhg6dckhu" }, request: { method: "GET", url: `${API}/predictions/gm3qorzdhgbfurvjtvhg6dckhu`, query: "absent" } },
    list_predictions: { args: { created_after: "2026-11-01T00:00:00Z" }, request: { method: "GET", url: `${API}/predictions`, query: { created_after: "2026-11-01T00:00:00Z" } } },
    cancel_prediction: { args: { prediction_id: "gm3q" }, request: { method: "POST", url: `${API}/predictions/gm3q/cancel`, query: "absent", body: "absent" } },
  },
});

function createRunner(responses) {
  const outputDirectory = mkdtempSync(join(tmpdir(), "replicate-test-"));
  const recordingFetch = createRecordingFetch(responses);
  const environment = { REPLICATE_API_TOKEN: "r8_test_not_real", REPLICATE_OUTPUT_DIR: outputDirectory, GRAPHRT_POLL_INTERVAL_MS: "0" };
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch, resolveHostAddresses: async () => ["93.184.216.34"] });
  return { run, calls: recordingFetch.calls, outputDirectory, cleanUp: () => rmSync(outputDirectory, { recursive: true, force: true }) };
}

const created = { id: "p1", status: "starting", urls: { get: `${API}/predictions/p1`, cancel: `${API}/predictions/p1/cancel` } };

test("run_model polls urls.get and downloads a single output URL", async () => {
  const { run, calls, outputDirectory, cleanUp } = createRunner([
    { status: 201, body: created },
    { body: { id: "p1", status: "processing" } },
    { body: { id: "p1", status: "succeeded", output: "https://replicate.delivery/xezq/out-0.webp" } },
    { body: "WEBP-BYTES", headers: { "content-type": "image/webp" } },
  ]);
  try {
    const { data } = await run("run_model", { model_owner: "black-forest-labs", model_name: "flux-schnell", input: { prompt: "fox" } }, { source: "tool" });
    assert.equal(data.status, "succeeded");
    assert.equal(data.result, "https://replicate.delivery/xezq/out-0.webp");
    assert.ok(data.saved_files[0].path.startsWith(outputDirectory));
    assert.equal(readFileSync(data.saved_files[0].path, "utf8"), "WEBP-BYTES");
    assert.equal(calls[1].url, `${API}/predictions/p1`);
    assert.equal(calls[3].headers.authorization, undefined, "the download carries no token");
  } finally {
    cleanUp();
  }
});

test("run_model downloads every URL of a list output", async () => {
  const { run, cleanUp } = createRunner([
    { status: 201, body: created },
    { body: { id: "p1", status: "succeeded", output: ["https://replicate.delivery/a.png", "https://replicate.delivery/b.png"] } },
    { body: "A", headers: { "content-type": "image/png" } },
    { body: "B", headers: { "content-type": "image/png" } },
  ]);
  try {
    const { data } = await run("run_model", { model_owner: "o", model_name: "m", input: {} }, { source: "node" });
    assert.equal(data.saved_files.length, 2);
  } finally {
    cleanUp();
  }
});

test("a failed prediction reports the model error with the prediction id, not retryable", async () => {
  const { run, cleanUp } = createRunner([{ status: 201, body: created }, { body: { id: "p1", status: "failed", error: "CUDA out of memory" } }]);
  await assert.rejects(run("run_model", { model_owner: "o", model_name: "m", input: {} }, { source: "tool" }), (error) => error.retryable === false && error.message.includes("p1") && error.message.includes("CUDA out of memory"));
  cleanUp();
});

test("a urls.get on another host is refused (the token is never sent there)", async () => {
  const { run, calls, cleanUp } = createRunner([{ status: 201, body: { ...created, urls: { get: "https://evil.example/predictions/p1" } } }]);
  await assert.rejects(run("run_model", { model_owner: "o", model_name: "m", input: {} }, { source: "tool" }), (error) => error.kind === "api_error" && error.retryable === false);
  assert.equal(calls.length, 1);
  cleanUp();
});

test("Replicate's problem-details body gives the detail message; 402 is permission_denied", async () => {
  const { run, cleanUp } = createRunner([
    { status: 401, body: { title: "Unauthenticated", detail: "You did not pass a valid authentication token", status: 401 } },
    { status: 402, body: { title: "Insufficient credit", detail: "You have insufficient credit to run this model.", status: 402 } },
  ]);
  await assert.rejects(run("get_account", {}, { source: "tool" }), (error) => error.kind === "auth_error" && error.message.includes("valid authentication token"));
  await assert.rejects(run("get_account", {}, { source: "tool" }), (error) => error.kind === "permission_denied");
  cleanUp();
});
