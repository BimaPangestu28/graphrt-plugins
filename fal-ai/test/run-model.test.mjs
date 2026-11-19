import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const QUEUE = "https://queue.fal.run";
const REQUEST_ID = "764cabcf-b745-4b3e-ae38-1200304cf45b";
const submitted = {
  request_id: REQUEST_ID,
  status_url: `${QUEUE}/fal-ai/flux/requests/${REQUEST_ID}/status`,
  response_url: `${QUEUE}/fal-ai/flux/requests/${REQUEST_ID}`,
  cancel_url: `${QUEUE}/fal-ai/flux/requests/${REQUEST_ID}/cancel`,
};

function createRunner(responses, extraEnvironment = {}) {
  const outputDirectory = mkdtempSync(join(tmpdir(), "fal-ai-run-"));
  const recordingFetch = createRecordingFetch(responses);
  const environment = { FAL_KEY: "fal-test-not-real", FAL_AI_OUTPUT_DIR: outputDirectory, GRAPHRT_POLL_INTERVAL_MS: "0", ...extraEnvironment };
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch, resolveHostAddresses: async () => ["93.184.216.34"] });
  return { run, calls: recordingFetch.calls, cleanUp: () => rmSync(outputDirectory, { recursive: true, force: true }) };
}

test("a request that COMPLETED with an error fails with fal's message and error_type, without fetching the result", async () => {
  const { run, calls, cleanUp } = createRunner([
    { body: submitted },
    { body: { status: "IN_PROGRESS" } },
    { body: { status: "COMPLETED", error: "NSFW content detected in the prompt", error_type: "content_policy_violation" } },
  ]);
  await assert.rejects(run("run_model", { model_id: "fal-ai/flux/dev", input: { prompt: "x" } }, { source: "tool" }), (error) => {
    assert.equal(error.kind, "api_error");
    assert.equal(error.retryable, false);
    assert.match(error.message, new RegExp(REQUEST_ID));
    assert.match(error.message, /NSFW content detected in the prompt/);
    assert.match(error.message, /content_policy_violation/);
    return true;
  });
  assert.equal(calls.length, 3, "submit and two status polls; no result fetch");
  cleanUp();
});

test("run_model downloads only fal.media URLs and reports others", async () => {
  const { run, calls, cleanUp } = createRunner([
    { body: submitted },
    { body: { status: "COMPLETED" } },
    { body: { images: [{ url: "https://v3.fal.media/files/b/1/a.png" }, { url: "https://attacker.example/b.png" }] } },
    { body: "PNG", headers: { "content-type": "image/png" } },
  ]);
  try {
    const { data } = await run("run_model", { model_id: "fal-ai/flux/dev", input: {} }, { source: "node" });
    assert.equal(calls.length, 4);
    assert.ok(data.saved_files.some((savedFile) => savedFile.url.startsWith("https://v3.fal.media/") && savedFile.path));
    assert.ok(data.saved_files.some((savedFile) => savedFile.url === "https://attacker.example/b.png" && /not downloaded/.test(savedFile.error)));
  } finally {
    cleanUp();
  }
});

test("get_request_result also restricts downloads to fal.media", async () => {
  const { run, calls, cleanUp } = createRunner([{ body: { video: { url: "https://attacker.example/v.mp4" } } }]);
  try {
    const { data } = await run("get_request_result", { owner: "fal-ai", app: "veo3", request_id: REQUEST_ID }, { source: "tool" });
    assert.equal(calls.length, 1);
    assert.match(data.saved_files[0].error, /not downloaded/);
  } finally {
    cleanUp();
  }
});

test("wait false returns the request id and URLs at once", async () => {
  const { run, calls, cleanUp } = createRunner([{ body: submitted }]);
  try {
    const { data } = await run("run_model", { model_id: "fal-ai/flux/dev", input: {}, wait: false }, { source: "tool" });
    assert.equal(data.job_id, REQUEST_ID);
    assert.equal(data.response.status_url, submitted.status_url);
    assert.equal(calls.length, 1);
  } finally {
    cleanUp();
  }
});

test("a job that stays in the queue times out with the request id, not retryable", async () => {
  const pending = Array.from({ length: 10 }, () => ({ body: { status: "IN_QUEUE", queue_position: 3 } }));
  const { run, cleanUp } = createRunner([{ body: submitted }, ...pending], { GRAPHRT_JOB_TIMEOUT_MS: "1" });
  await assert.rejects(run("run_model", { model_id: "fal-ai/flux/dev", input: {} }, { source: "tool" }), (error) => error.kind === "timeout" && error.retryable === false && error.message.includes(REQUEST_ID));
  cleanUp();
});
