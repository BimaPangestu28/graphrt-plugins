import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { buildPredictRequestBody } from "../lib/generate-video.mjs";
import { pluginDefinition } from "../definition.mjs";

const BASE = "https://us-central1-aiplatform.googleapis.com/v1/projects/my-project-1/locations/us-central1";
const MODEL = "veo-3.1-generate-001";
const OPERATION_NAME = `projects/my-project-1/locations/us-central1/publishers/google/models/${MODEL}/operations/a1b2c3`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ENVIRONMENT = {
  GOOGLE_CLOUD_PROJECT: "my-project-1",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_REFRESH_TOKEN: "refresh-token",
  GRAPHRT_POLL_INTERVAL_MS: "0",
};

async function runOperation(operationName, args, responses, { environment = {}, source = "node" } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  // The OAuth token request is answered on the side (tokens may be cached between tests).
  const fetchWithToken = async (url, init) => {
    if (String(url) === TOKEN_URL) return new Response(JSON.stringify({ access_token: "ya29.test-access-token", expires_in: 3600 }), { headers: { "content-type": "application/json" } });
    return recordingFetch(url, init);
  };
  const run = createOperationRunner(pluginDefinition, { ...ENVIRONMENT, ...environment }, { fetchImpl: fetchWithToken });
  return run(operationName, args, { source }).then(
    (result) => ({ result, calls: recordingFetch.calls }),
    (error) => ({ error, calls: recordingFetch.calls }),
  );
}

test("buildPredictRequestBody maps friendly params to instances and parameters", () => {
  const body = buildPredictRequestBody({
    prompt: "A paper boat on a pond",
    image_gcs_uri: "gs://bucket/first.png",
    last_frame_gcs_uri: "gs://bucket/last.png",
    image_mime_type: "image/png",
    aspect_ratio: "9:16",
    duration_seconds: 8,
    generate_audio: true,
    sample_count: 2,
    storage_uri: "gs://bucket/out/",
    negative_prompt: "text",
    seed: 3,
  });
  assert.deepEqual(body, {
    instances: [{ prompt: "A paper boat on a pond", image: { gcsUri: "gs://bucket/first.png", mimeType: "image/png" }, lastFrame: { gcsUri: "gs://bucket/last.png", mimeType: "image/png" } }],
    parameters: { aspectRatio: "9:16", durationSeconds: 8, generateAudio: true, sampleCount: 2, storageUri: "gs://bucket/out/", negativePrompt: "text", seed: 3 },
  });
});

test("buildPredictRequestBody supports inline images and video extension", () => {
  const body = buildPredictRequestBody({ prompt: "x", image_base64: "aGVsbG8=", image_mime_type: "image/jpeg", video_gcs_uri: "gs://b/v.mp4" });
  assert.deepEqual(body.instances[0], { prompt: "x", image: { bytesBase64Encoded: "aGVsbG8=", mimeType: "image/jpeg" }, video: { gcsUri: "gs://b/v.mp4", mimeType: "video/mp4" } });
  assert.deepEqual(body.parameters, {});
});

test("buildPredictRequestBody refuses ambiguous or incomplete images", () => {
  assert.throws(() => buildPredictRequestBody({ prompt: "x", image_gcs_uri: "gs://b/a.png", image_base64: "aGk=", image_mime_type: "image/png" }), (error) => error.kind === "invalid_input");
  assert.throws(() => buildPredictRequestBody({ prompt: "x", image_gcs_uri: "gs://b/a.png" }), (error) => error.kind === "invalid_input" && /image_mime_type/.test(error.message));
  assert.throws(() => buildPredictRequestBody({ prompt: "x", storage_uri: "https://example.com/out" }), (error) => error.kind === "invalid_input" && /gs:\/\//.test(error.message));
});

test("generate_video starts the operation, polls fetchPredictOperation and returns the videos", async () => {
  const videos = [{ gcsUri: "gs://bucket/out/sample_0.mp4", mimeType: "video/mp4" }];
  const { result, calls } = await runOperation("generate_video", { prompt: "A lighthouse at dusk", storage_uri: "gs://bucket/out/" }, [
    { body: { name: OPERATION_NAME } },
    { body: { name: OPERATION_NAME, done: false } },
    { body: { name: OPERATION_NAME, done: true, response: { raiMediaFilteredCount: 0, videos } } },
  ]);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${BASE}/publishers/google/models/${MODEL}:predictLongRunning`);
  assert.equal(calls[0].headers.authorization, "Bearer ya29.test-access-token");
  assert.deepEqual(calls[0].json, { instances: [{ prompt: "A lighthouse at dusk" }], parameters: { storageUri: "gs://bucket/out/" } });
  assert.equal(calls[1].url, `${BASE}/publishers/google/models/${MODEL}:fetchPredictOperation`);
  assert.deepEqual(calls[1].json, { operationName: OPERATION_NAME });
  assert.deepEqual(result.data, { job_id: OPERATION_NAME, model: MODEL, status: "done", result: { raiMediaFilteredCount: 0, videos }, saved_files: [] });
});

test("generate_video with wait:false returns the operation name at once", async () => {
  const { result, calls } = await runOperation("generate_video", { prompt: "x", wait: false }, [{ body: { name: OPERATION_NAME } }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(result.data, { job_id: OPERATION_NAME, model: MODEL, response: { name: OPERATION_NAME } });
});

test("a finished operation with an error is a failure that names the operation and is not retryable", async () => {
  const { error } = await runOperation("generate_video", { prompt: "x" }, [
    { body: { name: OPERATION_NAME } },
    { body: { name: OPERATION_NAME, done: true, error: { code: 3, message: "The prompt could not be submitted." } } },
  ]);
  assert.equal(error?.kind, "api_error");
  assert.equal(error.retryable, false);
  assert.match(error.message, /could not be submitted/);
  assert.ok(error.message.includes(OPERATION_NAME));
});

test("videos filtered by Responsible AI are reported as a failure with the reasons", async () => {
  const { error } = await runOperation("generate_video", { prompt: "x" }, [
    { body: { name: OPERATION_NAME } },
    { body: { name: OPERATION_NAME, done: true, response: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["Unsafe content"] } } },
  ]);
  assert.equal(error?.kind, "invalid_input");
  assert.equal(error.retryable, false);
  assert.match(error.message, /Unsafe content/);
});

test("a timeout names the operation and is not retryable", async () => {
  const pending = Array.from({ length: 10 }, () => ({ body: { name: OPERATION_NAME, done: false } }));
  const { error } = await runOperation("generate_video", { prompt: "x" }, [{ body: { name: OPERATION_NAME } }, ...pending], { environment: { GRAPHRT_JOB_TIMEOUT_MS: "1" } });
  assert.equal(error?.kind, "timeout");
  assert.equal(error.retryable, false);
  assert.ok(error.message.includes(OPERATION_NAME));
});

test("a failed create is not retried and says the outcome is unknown", async () => {
  const { error, calls } = await runOperation("generate_video", { prompt: "x" }, [{ status: 503, body: { error: { code: 503, message: "Backend unavailable", status: "UNAVAILABLE" } } }]);
  assert.equal(calls.length, 1);
  assert.equal(error.retryable, false);
  assert.match(error.message, /outcome unknown/);
});

test("inline videos are saved into GOOGLE_VEO_OUTPUT_DIR and replaced in the result", async () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "google-veo-test-"));
  try {
    const encodedVideo = Buffer.from("FAKE-MP4-BYTES").toString("base64");
    const { result } = await runOperation("generate_video", { prompt: "x" }, [
      { body: { name: OPERATION_NAME } },
      { body: { name: OPERATION_NAME, done: true, response: { videos: [{ bytesBase64Encoded: encodedVideo, mimeType: "video/mp4" }] } } },
    ], { environment: { GOOGLE_VEO_OUTPUT_DIR: outputDirectory } });
    const [savedFile] = result.data.saved_files;
    assert.ok(savedFile.path.startsWith(outputDirectory));
    assert.equal(readFileSync(savedFile.path, "utf8"), "FAKE-MP4-BYTES");
    assert.match(result.data.result.videos[0].bytesBase64Encoded, /^\[saved to /);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("generate_video is an agent tool and its schema is in the manifest", () => {
  const manifest = buildManifest(pluginDefinition);
  const toolNames = manifest.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("generate_video"));
  assert.ok(toolNames.includes("get_operation"));
});

test("GOOGLE_CLOUD_PROJECT is required and validated", async () => {
  const { error } = await runOperation("generate_video", { prompt: "x" }, [], { environment: { GOOGLE_CLOUD_PROJECT: "../evil" } });
  assert.equal(error?.kind, "invalid_input");
});

test("GOOGLE_CLOUD_PROJECT may be a numeric project number", async () => {
  const { calls } = await runOperation("generate_video", { prompt: "x", wait: false }, [{ body: { name: OPERATION_NAME } }], { environment: { GOOGLE_CLOUD_PROJECT: "123456789012" } });
  assert.equal(calls[0].url, "https://us-central1-aiplatform.googleapis.com/v1/projects/123456789012/locations/us-central1/publishers/google/models/veo-3.1-generate-001:predictLongRunning");
});

test("4K or several samples need storage_uri, because inline videos would be too large", async () => {
  for (const args of [{ resolution: "4k" }, { sample_count: 2 }]) {
    const { error, calls } = await runOperation("generate_video", { prompt: "x", ...args }, []);
    assert.equal(error?.kind, "invalid_input", JSON.stringify(args));
    assert.match(error.message, /storage_uri/);
    assert.equal(calls.length, 0, "nothing is billed");
  }
  assert.doesNotThrow(() => buildPredictRequestBody({ prompt: "x", resolution: "4k", sample_count: 4, storage_uri: "gs://bucket/out/" }));
});

test("person_generation takes the values in Google's Veo guides (allow_adult, disallow)", async () => {
  const { calls } = await runOperation("generate_video", { prompt: "x", person_generation: "disallow", wait: false }, [{ body: { name: OPERATION_NAME } }]);
  assert.equal(calls[0].json.parameters.personGeneration, "disallow");
  const { error } = await runOperation("generate_video", { prompt: "x", person_generation: "allowAll" }, []);
  assert.equal(error?.kind, "invalid_input");
});

test("get_operation has a long per-request timeout for inline video responses", () => {
  const getOperation = pluginDefinition.restSpec.operations.find((operation) => operation.name === "get_operation");
  assert.equal(getOperation.timeoutMs, 300000);
});
