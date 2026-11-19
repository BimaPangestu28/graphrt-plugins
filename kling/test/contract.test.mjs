import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api-singapore.klingai.com";
const TASK_ID = "893605946402811985";
const okBody = (data) => ({ code: 0, message: "SUCCEED", request_id: "r-1", data });

describeRestPluginContract(pluginDefinition, {
  operations: {
    text_to_video: {
      args: { model: "kling-4.0", prompt: "A girl on a train looks out the window", duration: 10, resolution: "1080p", aspect_ratio: "16:9", external_task_id: "order-42" },
      request: {
        method: "POST",
        url: `${API}/text-to-video/kling-4.0`,
        query: "absent",
        json: { prompt: "A girl on a train looks out the window", settings: { aspect_ratio: "16:9", resolution: "1080p", duration: 10 }, options: { external_task_id: "order-42" } },
      },
      response: { body: okBody({ id: TASK_ID, status: "submitted" }) },
    },
    image_to_video: {
      args: { model: "kling-4.0-flash", contents: [{ type: "prompt", text: "She smiles" }, { type: "first_frame", url: "https://example.com/f.png" }], duration: 5 },
      request: {
        method: "POST",
        url: `${API}/image-to-video/kling-4.0-flash`,
        query: "absent",
        json: { contents: [{ type: "prompt", text: "She smiles" }, { type: "first_frame", url: "https://example.com/f.png" }], settings: { duration: 5 } },
      },
      response: { body: okBody({ id: TASK_ID, status: "submitted" }) },
    },
    omni_video: {
      args: { model: "kling-3.0-omni", contents: [{ type: "prompt", text: "x" }], audio: "native", watermark: false },
      request: {
        method: "POST",
        url: `${API}/omni-video/kling-3.0-omni`,
        query: "absent",
        json: { contents: [{ type: "prompt", text: "x" }], settings: { audio: "native" }, options: { watermark_info: { enabled: false } } },
      },
      response: { body: okBody({ id: TASK_ID, status: "submitted" }) },
    },
    text_to_video_with_callback: {
      args: { model: "kling-4.0", prompt: "x", callback_url: "https://example.com/hook" },
      request: { method: "POST", url: `${API}/text-to-video/kling-4.0`, query: "absent", json: { prompt: "x", options: { callback_url: "https://example.com/hook" } } },
      response: { body: okBody({ id: TASK_ID, status: "submitted" }) },
    },
    image_to_video_with_callback: {
      args: { model: "kling-2.6", contents: [{ type: "prompt", text: "x" }], callback_url: "https://example.com/hook" },
      request: { method: "POST", url: `${API}/image-to-video/kling-2.6`, query: "absent", json: { contents: [{ type: "prompt", text: "x" }], options: { callback_url: "https://example.com/hook" } } },
      response: { body: okBody({ id: TASK_ID, status: "submitted" }) },
    },
    omni_video_with_callback: {
      args: { model: "kling-o1", contents: [{ type: "prompt", text: "x" }], callback_url: "https://example.com/hook" },
      request: { method: "POST", url: `${API}/omni-video/kling-o1`, query: "absent", json: { contents: [{ type: "prompt", text: "x" }], options: { callback_url: "https://example.com/hook" } } },
      response: { body: okBody({ id: TASK_ID, status: "submitted" }) },
    },
    get_tasks: {
      args: { task_ids: [TASK_ID, "2"] },
      request: { method: "GET", url: `${API}/tasks`, query: { task_ids: `${TASK_ID},2` } },
      response: { body: okBody([{ id: TASK_ID, status: "processing" }]) },
      expect: { data: { result: [{ id: TASK_ID, status: "processing" }], saved_files: [] } },
    },
    list_tasks: {
      args: { filters: [{ key: "status", values: ["succeeded"] }] },
      request: { method: "POST", url: `${API}/tasks`, query: "absent", json: { filters: [{ key: "status", values: ["succeeded"] }] } },
      response: { body: okBody({ result: [{ id: TASK_ID }], count: 1, next_cursor: "", has_more: false }) },
      expect: { data: [{ id: TASK_ID }] },
    },
    get_account_costs: {
      args: { start_time: 1726124664368, end_time: 1727366400000 },
      request: { method: "GET", url: `${API}/account/costs`, query: { start_time: "1726124664368", end_time: "1727366400000" } },
    },
  },
});

async function runOperation(operationName, args, responses, { environment = {}, source = "node" } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runnerOptions = { fetchImpl: recordingFetch, resolveHostAddresses: async () => ["93.184.216.34"] };
  const run = createOperationRunner(pluginDefinition, { KLING_API_KEY: "kling-test", GRAPHRT_POLL_INTERVAL_MS: "0", ...environment }, runnerOptions);
  return { result: await run(operationName, args, { source }), calls: recordingFetch.calls };
}

const CREATE_CASES = [
  ["text_to_video", { model: "kling-4.0", prompt: "x" }],
  ["image_to_video", { model: "kling-4.0", contents: [{ type: "prompt", text: "x" }] }],
  ["omni_video", { model: "kling-4.0", contents: [{ type: "prompt", text: "x" }] }],
];

test("an agent tool cannot set a callback URL on the create operations", async () => {
  for (const [operationName, args] of CREATE_CASES) {
    const { calls } = await runOperation(operationName, { ...args, callback_url: "https://attacker.example/hook", wait: false }, [{ body: okBody({ id: TASK_ID }) }], { source: "tool" });
    assert.equal(calls[0].json.options?.callback_url, undefined, operationName);
  }
});

test("the *_with_callback variants send options.callback_url and are node only", async () => {
  for (const [operationName, args] of CREATE_CASES) {
    const variantName = `${operationName}_with_callback`;
    const { calls } = await runOperation(variantName, { ...args, callback_url: "https://example.com/kling-hook", wait: false }, [{ body: okBody({ id: TASK_ID }) }]);
    assert.equal(calls[0].json.options.callback_url, "https://example.com/kling-hook", variantName);
    await assert.rejects(runOperation(variantName, { ...args, callback_url: "https://example.com/h" }, [], { source: "tool" }), (error) => error.kind === "invalid_input");
  }
});

test("omni_video accepts the adaptive aspect ratio", async () => {
  const { calls } = await runOperation("omni_video", { ...CREATE_CASES[2][1], aspect_ratio: "adaptive", wait: false }, [{ body: okBody({ id: TASK_ID }) }]);
  assert.equal(calls[0].json.settings.aspect_ratio, "adaptive");
});

test("get_tasks saves the outputs of a succeeded task into KLING_OUTPUT_DIR", async () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "kling-test-"));
  try {
    const outputs = [{ type: "video", id: "v1", url: "https://v1-kling.klingai.com/out/video.mp4", duration: "5.0" }];
    const { result, calls } = await runOperation("get_tasks", { task_ids: [TASK_ID] }, [
      { body: okBody([{ id: TASK_ID, status: "succeeded", outputs }]) },
      { body: "MP4-BYTES", headers: { "content-type": "video/mp4" } },
    ], { environment: { KLING_OUTPUT_DIR: outputDirectory } });
    assert.equal(calls[1].url, outputs[0].url);
    const [savedFile] = result.data.saved_files;
    assert.ok(savedFile.path.startsWith(outputDirectory));
    assert.equal(readFileSync(savedFile.path, "utf8"), "MP4-BYTES");
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("the task is polled with GET /tasks?task_ids=<id> and returns the outputs", async () => {
  const outputs = [{ type: "video", id: "v1", url: "https://v1-kling.example.com/v.mp4", duration: "10.0" }];
  const { result, calls } = await runOperation("text_to_video", { model: "kling-4.0", prompt: "x" }, [
    { body: okBody({ id: TASK_ID, status: "submitted" }) },
    { body: okBody([{ id: TASK_ID, status: "processing" }]) },
    { body: okBody([{ id: TASK_ID, status: "succeeded", outputs }]) },
  ]);
  assert.equal(calls[1].url, `${API}/tasks?task_ids=${TASK_ID}`);
  assert.deepEqual(result.data, { job_id: TASK_ID, status: "succeeded", result: outputs, saved_files: [] });
});

test("a failed task reports Kling's message and is not retryable", async () => {
  await assert.rejects(
    runOperation("text_to_video", { model: "kling-4.0", prompt: "x" }, [{ body: okBody({ id: TASK_ID, status: "submitted" }) }, { body: okBody([{ id: TASK_ID, status: "failed", message: "Triggered content risk control" }]) }]),
    (error) => error.kind === "api_error" && error.retryable === false && error.message.includes("risk control"),
  );
});

test("Kling service codes map to error kinds", async () => {
  const cases = [
    [401, 1002, "auth_error"],
    [429, 1102, "permission_denied"],
    [429, 1302, "rate_limited"],
    [400, 1301, "invalid_input"],
    [404, 1203, "not_found"],
  ];
  for (const [status, code, kind] of cases) {
    await assert.rejects(
      // Rate limits are retried for reads, so every attempt gets the same answer.
      runOperation("get_tasks", { task_ids: ["1"] }, Array.from({ length: 6 }, () => ({ status, body: { code, message: `kling error ${code}`, request_id: "r" } }))),
      (error) => error.kind === kind && error.message.includes(`kling error ${code}`),
      `code ${code}`,
    );
  }
});

test("a 200 response with a non-zero code is an error", async () => {
  await assert.rejects(
    runOperation("get_account_costs", { start_time: 1, end_time: 2 }, [{ body: { code: 1201, message: "start_time is invalid", request_id: "r" } }]),
    (error) => error.kind === "invalid_input" && error.message.includes("start_time is invalid"),
  );
});
