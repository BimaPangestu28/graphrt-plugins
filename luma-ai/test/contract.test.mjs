import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://agents.lumalabs.ai/v1";
const GENERATION_ID = "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e";

describeRestPluginContract(pluginDefinition, {
  operations: {
    generate_video: {
      args: { prompt: "A slow dolly shot through a misty greenhouse", aspect_ratio: "16:9", resolution: "720p", duration: "5s", start_frame_url: "https://example.com/first.png" },
      request: {
        method: "POST",
        url: `${API}/generations`,
        query: "absent",
        json: {
          type: "video",
          model: "ray-3.2",
          prompt: "A slow dolly shot through a misty greenhouse",
          aspect_ratio: "16:9",
          video: { resolution: "720p", duration: "5s", start_frame: { url: "https://example.com/first.png" } },
        },
      },
      response: { body: { id: GENERATION_ID, state: "queued", type: "video" } },
    },
    edit_video: {
      args: { prompt: "Moonlit 35mm film", source_generation_id: GENERATION_ID, strength: "flex_2", auto_controls: true },
      request: {
        method: "POST",
        url: `${API}/generations`,
        query: "absent",
        json: { type: "video_edit", model: "ray-3.2", prompt: "Moonlit 35mm film", source: { generation_id: GENERATION_ID }, video: { edit: { strength: "flex_2", auto_controls: true } } },
      },
    },
    reframe_video: {
      args: { aspect_ratio: "9:16", source_url: "https://example.com/in.mp4", source_media_type: "video/mp4", resolution: "540p" },
      request: {
        method: "POST",
        url: `${API}/generations`,
        query: "absent",
        json: { type: "video_reframe", model: "ray-3.2", aspect_ratio: "9:16", source: { url: "https://example.com/in.mp4", media_type: "video/mp4" }, video: { resolution: "540p" } },
      },
    },
    generate_image: {
      args: { prompt: "Iced coffee on marble", image_ref: [{ url: "https://example.com/ref.jpg" }], output_format: "jpeg" },
      request: {
        method: "POST",
        url: `${API}/generations`,
        query: "absent",
        json: { type: "image", model: "uni-1", prompt: "Iced coffee on marble", image_ref: [{ url: "https://example.com/ref.jpg" }], output_format: "jpeg" },
      },
    },
    get_generation: {
      args: { generation_id: GENERATION_ID },
      request: { method: "GET", url: `${API}/generations/${GENERATION_ID}`, query: "absent" },
      response: { body: { id: GENERATION_ID, state: "processing" } },
      expect: { data: { result: { id: GENERATION_ID, state: "processing" }, saved_files: [] } },
    },
    delete_generation: {
      args: { generation_id: GENERATION_ID },
      request: { method: "DELETE", url: `${API}/generations/${GENERATION_ID}`, query: "absent", body: "absent" },
    },
    get_deletion: {
      args: { task_id: "d-1" },
      request: { method: "GET", url: `${API}/deletions/d-1`, query: "absent" },
    },
    get_credits: {
      args: {},
      request: { method: "GET", url: `${API}/credits`, query: "absent" },
      response: { body: { balance_credits: 49512 } },
      expect: { data: { balance_credits: 49512 } },
    },
    get_usage: {
      args: { group_by: "model", start: "2026-11-01T00:00:00Z" },
      request: { method: "GET", url: `${API}/usage`, query: { group_by: "model", start: "2026-11-01T00:00:00Z" } },
    },
  },
});

async function runOperation(operationName, args, responses, environment = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runnerOptions = { fetchImpl: recordingFetch, resolveHostAddresses: async () => ["93.184.216.34"] };
  const run = createOperationRunner(pluginDefinition, { LUMA_API_KEY: "luma-test", GRAPHRT_POLL_INTERVAL_MS: "0", ...environment }, runnerOptions);
  return { result: await run(operationName, args, { source: "node" }), calls: recordingFetch.calls };
}

test("get_generation saves the outputs of a completed generation into LUMA_OUTPUT_DIR", async () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "luma-ai-test-"));
  try {
    const output = [{ type: "video", url: "https://storage.cdn-luma.com/out/video.mp4" }];
    const { result, calls } = await runOperation("get_generation", { generation_id: GENERATION_ID }, [
      { body: { id: GENERATION_ID, state: "completed", output, usage: { credits_charged: 100 } } },
      { body: "MP4-BYTES", headers: { "content-type": "video/mp4" } },
    ], { LUMA_OUTPUT_DIR: outputDirectory });
    assert.equal(calls[1].url, output[0].url);
    const [savedFile] = result.data.saved_files;
    assert.ok(savedFile.path.startsWith(outputDirectory));
    assert.equal(readFileSync(savedFile.path, "utf8"), "MP4-BYTES");
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("a finished generation returns its output list", async () => {
  const output = [{ type: "video", url: "https://storage.example.com/v.mp4" }];
  const { result } = await runOperation("generate_video", { prompt: "x" }, [{ body: { id: GENERATION_ID, state: "queued" } }, { body: { id: GENERATION_ID, state: "completed", output } }]);
  assert.deepEqual(result.data, { job_id: GENERATION_ID, status: "completed", result: output, saved_files: [] });
});

test("a failed generation reports failure_reason and is not retryable", async () => {
  await assert.rejects(
    runOperation("generate_video", { prompt: "x" }, [{ body: { id: GENERATION_ID, state: "queued" } }, { body: { id: GENERATION_ID, state: "failed", failure_code: "content_moderated", failure_reason: "Prompt violated content guidelines" } }]),
    (error) => error.kind === "api_error" && error.retryable === false && error.message.includes("content guidelines"),
  );
});

test("detail objects and strings both become the error message", async () => {
  await assert.rejects(
    runOperation("get_credits", {}, [{ status: 401, body: { detail: { code: "AUTH.UNAUTHENTICATED", message: "Missing or invalid API key" } } }]),
    (error) => error.kind === "auth_error" && error.message.includes("Missing or invalid API key"),
  );
  await assert.rejects(
    runOperation("generate_video", { prompt: "x" }, [{ status: 402, body: { detail: "Insufficient balance" } }]),
    (error) => error.kind === "permission_denied" && error.message.includes("Insufficient balance"),
  );
});

test("a moderated input (422 USER.ARTIFACT.MODERATED) is invalid_input", async () => {
  await assert.rejects(
    runOperation("generate_video", { prompt: "x" }, [{ status: 422, body: { detail: "Input was rejected by moderation", error: { code: "USER.ARTIFACT.MODERATED", retry: false } } }]),
    (error) => error.kind === "invalid_input" && error.message.includes("moderation"),
  );
});
