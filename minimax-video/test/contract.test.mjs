import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.minimax.io";
const TASK_ID = "424010985738629";
const FILE_ID = "176844028768320";
const BASE_OK = { status_code: 0, status_msg: "success" };
const TEXT_CONTENT = [{ type: "text", text: "A boy playing basketball by the sea" }];

describeRestPluginContract(pluginDefinition, {
  operations: {
    generate_video: {
      args: { content: TEXT_CONTENT, resolution: "2K", ratio: "16:9", generate_audio: false },
      request: {
        method: "POST",
        url: `${API}/v2/video_generation`,
        query: "absent",
        json: { model: "MiniMax-H3", content: TEXT_CONTENT, resolution: "2K", duration: 5, ratio: "16:9", generate_audio: false },
      },
      response: { body: { task_id: TASK_ID } },
    },
    generate_video_with_callback: {
      args: { content: TEXT_CONTENT, ratio: "16:9", callback_url: "https://example.com/hook" },
      request: {
        method: "POST",
        url: `${API}/v2/video_generation`,
        query: "absent",
        json: { model: "MiniMax-H3", content: TEXT_CONTENT, resolution: "768P", duration: 5, ratio: "16:9", callback_url: "https://example.com/hook" },
      },
      response: { body: { task_id: TASK_ID } },
    },
    generate_hailuo_video_with_callback: {
      args: { prompt: "x", callback_url: "https://example.com/hook" },
      request: { method: "POST", url: `${API}/v1/video_generation`, query: "absent", json: { model: "MiniMax-Hailuo-2.3", prompt: "x", callback_url: "https://example.com/hook" } },
      response: { body: { task_id: TASK_ID, base_resp: BASE_OK } },
    },
    get_task: {
      args: { task_id: TASK_ID },
      request: { method: "GET", url: `${API}/v2/query/video_generation/${TASK_ID}`, query: "absent" },
      response: { body: { task: { id: TASK_ID, status: "running" } } },
      expect: { data: { result: { task: { id: TASK_ID, status: "running" } }, saved_files: [] } },
    },
    list_tasks: {
      args: { status: "succeeded", model: "MiniMax-H3" },
      request: { method: "GET", url: `${API}/v2/query/video_generation`, query: { "filter.status": "succeeded", "filter.model": "MiniMax-H3" } },
      response: { body: { items: [{ id: TASK_ID }], total: 1 } },
      expect: { data: [{ id: TASK_ID }] },
    },
    delete_task: {
      args: { task_id: TASK_ID },
      request: { method: "DELETE", url: `${API}/v2/video_generation/${TASK_ID}`, query: "absent", body: "absent" },
    },
    generate_hailuo_video: {
      args: { prompt: "A cat runs [Tracking shot]", first_frame_image: "https://example.com/cat.png", duration: 6, resolution: "1080P" },
      request: {
        method: "POST",
        url: `${API}/v1/video_generation`,
        query: "absent",
        json: { model: "MiniMax-Hailuo-2.3", prompt: "A cat runs [Tracking shot]", first_frame_image: "https://example.com/cat.png", duration: 6, resolution: "1080P" },
      },
      response: { body: { task_id: TASK_ID, base_resp: BASE_OK } },
    },
    get_hailuo_task: {
      args: { task_id: TASK_ID },
      request: { method: "GET", url: `${API}/v1/query/video_generation`, query: { task_id: TASK_ID } },
      response: { body: { task_id: TASK_ID, status: "Processing", base_resp: BASE_OK } },
    },
    retrieve_file: {
      args: { file_id: FILE_ID },
      request: { method: "GET", url: `${API}/v1/files/retrieve`, query: { file_id: FILE_ID } },
      response: { body: { file: { file_id: FILE_ID, download_url: null }, base_resp: BASE_OK } },
    },
  },
});

async function runOperation(operationName, args, responses, environment = {}, source = "node") {
  const recordingFetch = createRecordingFetch(responses);
  const runnerOptions = { fetchImpl: recordingFetch, resolveHostAddresses: async () => ["93.184.216.34"] };
  const run = createOperationRunner(pluginDefinition, { MINIMAX_API_KEY: "mm-test", GRAPHRT_POLL_INTERVAL_MS: "0", ...environment }, runnerOptions);
  return { result: await run(operationName, args, { source }), calls: recordingFetch.calls };
}

const CREATE_CASES = [
  ["generate_video", { content: TEXT_CONTENT, ratio: "16:9" }, { task_id: TASK_ID }],
  ["generate_hailuo_video", { prompt: "x" }, { task_id: TASK_ID, base_resp: BASE_OK }],
];

test("an agent tool cannot set a callback URL on the create operations", async () => {
  for (const [operationName, args, createBody] of CREATE_CASES) {
    const { calls } = await runOperation(operationName, { ...args, callback_url: "https://attacker.example/hook", wait: false }, [{ body: createBody }], {}, "tool");
    assert.equal(calls[0].json.callback_url, undefined, operationName);
  }
});

test("the *_with_callback variants send callback_url and are node only", async () => {
  for (const [operationName, args, createBody] of CREATE_CASES) {
    const variantName = `${operationName}_with_callback`;
    const { calls } = await runOperation(variantName, { ...args, callback_url: "https://example.com/mm-hook", wait: false }, [{ body: createBody }]);
    assert.equal(calls[0].json.callback_url, "https://example.com/mm-hook", variantName);
    await assert.rejects(runOperation(variantName, { ...args, callback_url: "https://example.com/h" }, [], {}, "tool"), (error) => error.kind === "invalid_input");
  }
});

async function withOutputDirectory(runTest) {
  const outputDirectory = mkdtempSync(join(tmpdir(), "minimax-video-test-"));
  try {
    await runTest(outputDirectory);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
}

function assertSavedInto(result, outputDirectory) {
  const [savedFile] = result.data.saved_files;
  assert.ok(savedFile?.path?.startsWith(outputDirectory), JSON.stringify(result.data.saved_files));
  assert.equal(readFileSync(savedFile.path, "utf8"), "MP4-BYTES");
}

const VIDEO_FILE = { body: "MP4-BYTES", headers: { "content-type": "video/mp4" } };

test("get_task saves the video of a succeeded H3 task into MINIMAX_OUTPUT_DIR", async () => {
  await withOutputDirectory(async (outputDirectory) => {
    const url = "https://cdn.hailuoai.com/out/video.mp4";
    const { result, calls } = await runOperation("get_task", { task_id: TASK_ID }, [{ body: { task: { id: TASK_ID, status: "succeeded", content: { url } } } }, VIDEO_FILE], { MINIMAX_OUTPUT_DIR: outputDirectory });
    assert.equal(calls[1].url, url);
    assertSavedInto(result, outputDirectory);
  });
});

test("retrieve_file saves the Hailuo video behind file.download_url", async () => {
  await withOutputDirectory(async (outputDirectory) => {
    const url = "https://public-cdn-video-data-algeng.oss-cn-wulanchabu.aliyuncs.com/out.mp4";
    const { result, calls } = await runOperation("retrieve_file", { file_id: FILE_ID }, [{ body: { file: { file_id: FILE_ID, download_url: url }, base_resp: BASE_OK } }, VIDEO_FILE], { MINIMAX_OUTPUT_DIR: outputDirectory });
    assert.equal(calls[1].url, url);
    assertSavedInto(result, outputDirectory);
  });
});

test("an H3 task returns the video URL from the query response", async () => {
  const { result } = await runOperation("generate_video", { content: TEXT_CONTENT, ratio: "16:9" }, [
    { body: { task_id: TASK_ID } },
    { body: { task: { id: TASK_ID, status: "running" } } },
    { body: { task: { id: TASK_ID, status: "succeeded", content: { url: "https://cdn.example.com/out.mp4" } } } },
  ]);
  assert.deepEqual(result.data, { job_id: TASK_ID, status: "succeeded", result: { url: "https://cdn.example.com/out.mp4" }, saved_files: [] });
});

test("a failed H3 task reports its error message", async () => {
  await assert.rejects(
    runOperation("generate_video", { content: TEXT_CONTENT, ratio: "16:9" }, [{ body: { task_id: TASK_ID } }, { body: { task: { id: TASK_ID, status: "failed", error: { code: "1026", message: "video description contains sensitive content" } } } }]),
    (error) => error.kind === "api_error" && error.retryable === false && error.message.includes("sensitive content"),
  );
});

test("a Hailuo task waits for Success and returns the file_id", async () => {
  const { result, calls } = await runOperation("generate_hailuo_video", { prompt: "x" }, [
    { body: { task_id: TASK_ID, base_resp: BASE_OK } },
    { body: { task_id: TASK_ID, status: "Queueing", base_resp: BASE_OK } },
    { body: { task_id: TASK_ID, status: "Success", file_id: FILE_ID, base_resp: BASE_OK } },
  ]);
  assert.equal(calls[1].url, `${API}/v1/query/video_generation?task_id=${TASK_ID}`);
  assert.deepEqual(result.data, { job_id: TASK_ID, status: "Success", result: FILE_ID });
});

test("V1 errors in a 200 base_resp and V2 HTTP errors both map to kinds", async () => {
  await assert.rejects(
    runOperation("get_hailuo_task", { task_id: TASK_ID }, [{ body: { base_resp: { status_code: 1004, status_msg: "login fail: Please carry the API secret key" } } }]),
    (error) => error.kind === "auth_error" && error.message.includes("login fail"),
  );
  await assert.rejects(
    runOperation("generate_video", { content: TEXT_CONTENT, ratio: "16:9" }, [{ status: 402, body: { type: "error", error: { type: "insufficient_balance_error", message: "insufficient balance (1008)", http_code: "402" } } }]),
    (error) => error.kind === "permission_denied" && error.message.includes("insufficient balance"),
  );
});

test("MINIMAX_REGION=china uses api.minimaxi.com and other values are refused", async () => {
  const { calls } = await runOperation("get_task", { task_id: TASK_ID }, [{ body: { task: {} } }], { MINIMAX_REGION: "china" });
  assert.equal(new URL(calls[0].url).origin, "https://api.minimaxi.com");
  await assert.rejects(runOperation("get_task", { task_id: TASK_ID }, [], { MINIMAX_REGION: "mars" }), (error) => error.kind === "invalid_input");
  assert.ok(buildManifest(pluginDefinition).permissions.env.includes("MINIMAX_REGION"));
});
