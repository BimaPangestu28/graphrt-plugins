import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.dev.runwayml.com";
const TASK_ID = "17f20503-6c24-4c16-946b-35dbbce2af2f";

describeRestPluginContract(pluginDefinition, {
  operations: {
    image_to_video: {
      args: { prompt_image: "https://example.com/cat.png", prompt_text: "The cat jumps", ratio: "1280:720", duration: 5, public_figure_threshold: "low" },
      request: {
        method: "POST",
        url: `${API}/v1/image_to_video`,
        query: "absent",
        json: { model: "gen4.5", promptImage: "https://example.com/cat.png", promptText: "The cat jumps", ratio: "1280:720", duration: 5, contentModeration: { publicFigureThreshold: "low" } },
      },
      response: { body: { id: TASK_ID, estimatedCost: { credits: 60 } } },
    },
    text_to_video: {
      args: { model: "veo3.1_fast", prompt_text: "A lighthouse at dusk", ratio: "1920:1080", duration: 8, audio: false, negative_prompt: "text", seed: 7 },
      request: {
        method: "POST",
        url: `${API}/v1/text_to_video`,
        query: "absent",
        json: { model: "veo3.1_fast", promptText: "A lighthouse at dusk", ratio: "1920:1080", duration: 8, audio: false, negativePrompt: "text", seed: 7 },
      },
    },
    video_to_video: {
      args: { video_uri: "https://example.com/in.mp4", prompt_text: "Make it snow", keyframes: [{ uri: "https://example.com/k.png", at: 0.5 }] },
      request: {
        method: "POST",
        url: `${API}/v1/video_to_video`,
        query: "absent",
        json: { model: "aleph2", videoUri: "https://example.com/in.mp4", promptText: "Make it snow", keyframes: [{ uri: "https://example.com/k.png", at: 0.5 }] },
      },
    },
    video_upscale: {
      args: { video_uri: "https://example.com/in.mp4", resolution: "4k", creativity: 20 },
      request: { method: "POST", url: `${API}/v1/video_upscale`, query: "absent", json: { model: "magnific_video_upscaler_creative", videoUri: "https://example.com/in.mp4", resolution: "4k", creativity: 20 } },
    },
    text_to_image: {
      args: { prompt_text: "@cat on a sofa", ratio: "1024:1024", reference_images: [{ uri: "https://example.com/cat.png", tag: "cat" }] },
      request: {
        method: "POST",
        url: `${API}/v1/text_to_image`,
        query: "absent",
        json: { model: "gen4_image", promptText: "@cat on a sofa", ratio: "1024:1024", referenceImages: [{ uri: "https://example.com/cat.png", tag: "cat" }] },
      },
    },
    get_task: {
      args: { task_id: TASK_ID },
      request: { method: "GET", url: `${API}/v1/tasks/${TASK_ID}`, query: "absent" },
      response: { body: { id: TASK_ID, status: "RUNNING", progress: 0.4 } },
      expect: { data: { result: { id: TASK_ID, status: "RUNNING", progress: 0.4 }, saved_files: [] } },
    },
    cancel_task: {
      args: { task_id: TASK_ID },
      request: { method: "DELETE", url: `${API}/v1/tasks/${TASK_ID}`, query: "absent", body: "absent" },
    },
    get_organization: {
      args: {},
      request: { method: "GET", url: `${API}/v1/organization`, query: "absent" },
      response: { body: { creditBalance: 1200 } },
      expect: { data: { creditBalance: 1200 } },
    },
    query_usage: {
      args: { start_date: "2026-11-01", before_date: "2026-11-19" },
      request: { method: "POST", url: `${API}/v1/organization/usage`, query: "absent", json: { startDate: "2026-11-01", beforeDate: "2026-11-19" } },
    },
  },
});

async function runOperation(operationName, args, responses, environment = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runnerOptions = { fetchImpl: recordingFetch, resolveHostAddresses: async () => ["93.184.216.34"] };
  const run = createOperationRunner(pluginDefinition, { RUNWAY_API_KEY: "key_test", GRAPHRT_POLL_INTERVAL_MS: "0", ...environment }, runnerOptions);
  return { result: await run(operationName, args, { source: "node" }), calls: recordingFetch.calls };
}

test("ratio is optional, for models that pick their own frame (kling_4, h3_max)", async () => {
  const { calls } = await runOperation("text_to_video", { model: "h3_max", prompt_text: "x", wait: false }, [{ body: { id: TASK_ID } }]);
  assert.deepEqual(calls[0].json, { model: "h3_max", promptText: "x" });
});

test("video_to_video sends promptVideo for the models that expect it (seedance2, hailuo3, klingO3)", async () => {
  const { calls } = await runOperation("video_to_video", { model: "seedance2", prompt_video: "https://example.com/in.mp4", prompt_text: "x", wait: false }, [{ body: { id: TASK_ID } }]);
  assert.deepEqual(calls[0].json, { model: "seedance2", promptVideo: "https://example.com/in.mp4", promptText: "x" });
});

test("get_task saves the output URLs of a SUCCEEDED task into RUNWAY_OUTPUT_DIR", async () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "runway-test-"));
  try {
    const output = ["https://dnznrvs05pmza.cloudfront.net/a/video.mp4"];
    const { result, calls } = await runOperation("get_task", { task_id: TASK_ID }, [
      { body: { id: TASK_ID, status: "SUCCEEDED", output, cost: { credits: 60 } } },
      { body: "MP4-BYTES", headers: { "content-type": "video/mp4" } },
    ], { RUNWAY_OUTPUT_DIR: outputDirectory });
    assert.equal(calls[1].url, output[0]);
    const [savedFile] = result.data.saved_files;
    assert.ok(savedFile.path.startsWith(outputDirectory));
    assert.equal(readFileSync(savedFile.path, "utf8"), "MP4-BYTES");
    assert.deepEqual(result.data.result.output, output);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("every request carries the X-Runway-Version header", async () => {
  const { calls } = await runOperation("get_organization", {}, [{ body: {} }]);
  assert.equal(calls[0].headers["x-runway-version"], "2024-11-06");
});

test("wait:false returns the task id at once so a later run can poll get_task", async () => {
  const { result, calls } = await runOperation("text_to_video", { prompt_text: "x", ratio: "1280:720", duration: 5, wait: false }, [{ body: { id: TASK_ID } }]);
  assert.equal(result.data.job_id, TASK_ID);
  assert.equal(calls.length, 1);
});

test("a FAILED task reports Runway's failure reason and is not retryable", async () => {
  await assert.rejects(
    runOperation("text_to_video", { prompt_text: "x", ratio: "1280:720", duration: 5 }, [{ body: { id: TASK_ID } }, { body: { id: TASK_ID, status: "FAILED", failure: "Content moderation", failureCode: "SAFETY.INPUT.TEXT" } }]),
    (error) => error.kind === "api_error" && error.retryable === false && error.message.includes("Content moderation") && error.message.includes(TASK_ID),
  );
});

test("Runway's {error} body becomes the error message", async () => {
  await assert.rejects(
    runOperation("get_organization", {}, [{ status: 401, body: { error: "The provided API key in the Authorization header did not start with `key_`." } }]),
    (error) => error.kind === "auth_error" && error.message.includes("did not start with"),
  );
});

test("cancel_task is not offered to agents", async () => {
  const run = createOperationRunner(pluginDefinition, { RUNWAY_API_KEY: "key_test" }, { fetchImpl: createRecordingFetch([]) });
  await assert.rejects(run("cancel_task", { task_id: TASK_ID }, { source: "tool" }), (error) => error.kind === "invalid_input");
});
