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
const PREDICTION_ID = "gm3qorzdhgbfurvjtvhg6dckhu";
const VERSION_ID = "5c7d5dc6dd8bf75c1acaa8565735e7986bc5b66206b55cca93cb72c9bf15ccaa";

describeRestPluginContract(pluginDefinition, {
  operations: {
    run_model: {
      args: { model_owner: "google", model_name: "veo-3", input: { prompt: "A paper boat on a pond", duration: 8 }, cancel_after: "20m" },
      request: {
        method: "POST",
        url: `${API}/models/google/veo-3/predictions`,
        query: "absent",
        headers: { "cancel-after": "20m" },
        json: { input: { prompt: "A paper boat on a pond", duration: 8 } },
      },
      response: { body: { id: PREDICTION_ID, status: "starting" } },
    },
    run_version: {
      args: { version: VERSION_ID, input: { prompt: "x" } },
      request: { method: "POST", url: `${API}/predictions`, query: "absent", json: { version: VERSION_ID, input: { prompt: "x" } } },
    },
    run_model_with_webhook: {
      args: { model_owner: "google", model_name: "veo-3", input: { prompt: "x" }, webhook: "https://example.com/hook", webhook_events_filter: ["completed"] },
      request: {
        method: "POST",
        url: `${API}/models/google/veo-3/predictions`,
        query: "absent",
        json: { input: { prompt: "x" }, webhook: "https://example.com/hook", webhook_events_filter: ["completed"] },
      },
    },
    run_version_with_webhook: {
      args: { version: VERSION_ID, input: { prompt: "x" }, webhook: "https://example.com/hook" },
      request: { method: "POST", url: `${API}/predictions`, query: "absent", json: { version: VERSION_ID, input: { prompt: "x" }, webhook: "https://example.com/hook" } },
    },
    get_prediction: {
      args: { prediction_id: PREDICTION_ID },
      request: { method: "GET", url: `${API}/predictions/${PREDICTION_ID}`, query: "absent" },
      response: { body: { id: PREDICTION_ID, status: "processing", output: null } },
      expect: { data: { result: { id: PREDICTION_ID, status: "processing", output: null }, saved_files: [] } },
    },
    cancel_prediction: {
      args: { prediction_id: PREDICTION_ID },
      request: { method: "POST", url: `${API}/predictions/${PREDICTION_ID}/cancel`, query: "absent", body: "absent" },
    },
    list_predictions: {
      args: { created_after: "2026-11-01T00:00:00Z" },
      request: { method: "GET", url: `${API}/predictions`, query: { created_after: "2026-11-01T00:00:00Z" } },
      response: { body: { results: [{ id: PREDICTION_ID }], next: null } },
      expect: { data: [{ id: PREDICTION_ID }] },
    },
    get_model: {
      args: { model_owner: "minimax", model_name: "hailuo-02" },
      request: { method: "GET", url: `${API}/models/minimax/hailuo-02`, query: "absent" },
    },
    list_model_versions: {
      args: { model_owner: "minimax", model_name: "hailuo-02" },
      request: { method: "GET", url: `${API}/models/minimax/hailuo-02/versions`, query: "absent" },
    },
    get_collection: {
      args: { collection_slug: "text-to-video" },
      request: { method: "GET", url: `${API}/collections/text-to-video`, query: "absent" },
    },
    search_models: {
      args: { query: "lip sync video", limit: 5 },
      request: { method: "GET", url: `${API}/search`, query: { query: "lip sync video", limit: "5" } },
    },
    get_account: {
      args: {},
      request: { method: "GET", url: `${API}/account`, query: "absent" },
      response: { body: { type: "user", username: "someone" } },
      expect: { data: { type: "user", username: "someone" } },
    },
  },
});

async function runOperation(operationName, args, responses, environment = {}, source = "node") {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(
    pluginDefinition,
    { REPLICATE_API_TOKEN: "r8_test", GRAPHRT_POLL_INTERVAL_MS: "0", ...environment },
    { fetchImpl: recordingFetch, resolveHostAddresses: async () => ["93.184.216.34"] },
  );
  return { result: await run(operationName, args, { source }), calls: recordingFetch.calls };
}

test("an agent tool cannot set a webhook: run_model and run_version drop it", async () => {
  for (const [operationName, args] of [["run_model", { model_owner: "google", model_name: "veo-3" }], ["run_version", { version: VERSION_ID }]]) {
    const toolArgs = { ...args, input: { prompt: "x" }, webhook: "https://attacker.example/hook", webhook_events_filter: ["completed"], wait: false };
    const { calls } = await runOperation(operationName, toolArgs, [{ body: { id: PREDICTION_ID, status: "starting" } }], {}, "tool");
    assert.equal(calls[0].json.webhook, undefined, operationName);
    assert.equal(calls[0].json.webhook_events_filter, undefined, operationName);
  }
});

test("the webhook variants are not agent tools", async () => {
  for (const operationName of ["run_model_with_webhook", "run_version_with_webhook"]) {
    await assert.rejects(runOperation(operationName, { version: VERSION_ID, model_owner: "a", model_name: "b", input: {}, webhook: "https://example.com/h" }, [], {}, "tool"), (error) => error.kind === "invalid_input");
  }
});

test("get_prediction saves the output of a succeeded prediction into REPLICATE_OUTPUT_DIR", async () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "replicate-video-status-"));
  try {
    const output = "https://replicate.delivery/xezq/out.mp4";
    const { result, calls } = await runOperation("get_prediction", { prediction_id: PREDICTION_ID }, [
      { body: { id: PREDICTION_ID, status: "succeeded", output } },
      { body: "MP4-BYTES", headers: { "content-type": "video/mp4" } },
    ], { REPLICATE_OUTPUT_DIR: outputDirectory });
    assert.equal(calls[1].url, output);
    const [savedFile] = result.data.saved_files;
    assert.ok(savedFile.path.startsWith(outputDirectory));
    assert.equal(readFileSync(savedFile.path, "utf8"), "MP4-BYTES");
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("a list output saves every file URL", async () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "replicate-video-test-"));
  try {
    const output = ["https://replicate.delivery/a/out-0.mp4", "https://replicate.delivery/a/out-1.mp4"];
    const responses = [
      { body: { id: PREDICTION_ID, status: "starting" } },
      { body: { id: PREDICTION_ID, status: "succeeded", output } },
      { body: "VIDEO-0", headers: { "content-type": "video/mp4" } },
      { body: "VIDEO-1", headers: { "content-type": "video/mp4" } },
    ];
    const { result, calls } = await runOperation("run_model", { model_owner: "google", model_name: "veo-3", input: { prompt: "x" } }, responses, { REPLICATE_OUTPUT_DIR: outputDirectory });
    assert.equal(result.data.saved_files.length, 2);
    assert.ok(result.data.saved_files.every((savedFile) => savedFile.path?.startsWith(outputDirectory)));
    assert.equal(calls[1].headers.authorization, "Bearer r8_test", "the status poll is authenticated");
    assert.equal(new URL(calls[2].url).host, "replicate.delivery");
    assert.equal(calls[2].headers?.authorization, undefined, "the token is never sent to the file host");
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("a canceled prediction is reported as a failure that is not retryable", async () => {
  await assert.rejects(
    runOperation("run_model", { model_owner: "google", model_name: "veo-3", input: { prompt: "x" } }, [{ body: { id: PREDICTION_ID, status: "starting" } }, { body: { id: PREDICTION_ID, status: "canceled", error: null } }]),
    (error) => error.kind === "api_error" && error.retryable === false && error.message.includes(PREDICTION_ID),
  );
});

test("Replicate's problem detail becomes the error message", async () => {
  await assert.rejects(
    runOperation("get_account", {}, [{ status: 401, body: { title: "Unauthenticated", detail: "You did not pass a valid authentication token", status: 401 } }]),
    (error) => error.kind === "auth_error" && error.message.includes("valid authentication token"),
  );
});
