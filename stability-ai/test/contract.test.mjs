import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.stability.ai";
const FILE = "https://files.contract.example";
const GENERATION_ID = "a".repeat(64);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

const multipartCase = (path, args, multipart) => ({
  args,
  request: { method: "POST", url: `${API}${path}`, query: "absent", multipart, headers: { accept: "image/*" } },
});

describeRestPluginContract(pluginDefinition, {
  operations: {
    get_account: { args: {}, request: { method: "GET", url: `${API}/v1/user/account`, query: "absent" }, response: { body: { id: "user-1", email: "a@example.com" } }, expect: { data: { id: "user-1", email: "a@example.com" } } },
    get_balance: { args: {}, request: { method: "GET", url: `${API}/v1/user/balance`, query: "absent" }, response: { body: { credits: 12.5 } }, expect: { data: { credits: 12.5 } } },
    generate_ultra: multipartCase("/v2beta/stable-image/generate/ultra", { prompt: "A lighthouse", aspect_ratio: "16:9", seed: 42 }, { prompt: "A lighthouse", aspect_ratio: "16:9", seed: "42" }),
    generate_core: multipartCase("/v2beta/stable-image/generate/core", { prompt: "A fox", style_preset: "anime", output_format: "webp" }, { prompt: "A fox", style_preset: "anime", output_format: "webp" }),
    generate_sd3: multipartCase(
      "/v2beta/stable-image/generate/sd3",
      { prompt: "A castle", model: "sd3.5-large-turbo", mode: "image-to-image", image: `${FILE}/start.png`, strength: 0.6 },
      { prompt: "A castle", model: "sd3.5-large-turbo", mode: "image-to-image", image: "start.png", strength: "0.6" },
    ),
    upscale_fast: multipartCase("/v2beta/stable-image/upscale/fast", { image: `${FILE}/small.png` }, { image: "small.png" }),
    upscale_conservative: multipartCase("/v2beta/stable-image/upscale/conservative", { image: `${FILE}/small.png`, prompt: "A portrait", creativity: 0.3 }, { image: "small.png", prompt: "A portrait", creativity: "0.3" }),
    upscale_creative: {
      args: { image: `${FILE}/blurry.jpg`, prompt: "A city at night", creativity: 0.2 },
      request: { method: "POST", url: `${API}/v2beta/stable-image/upscale/creative`, query: "absent", multipart: { image: "blurry.jpg", prompt: "A city at night", creativity: "0.2" } },
      response: { body: { id: GENERATION_ID } },
    },
    get_result: {
      args: { generation_id: GENERATION_ID },
      request: { method: "GET", url: `${API}/v2beta/results/${GENERATION_ID}`, query: "absent" },
      response: { status: 202, body: { id: GENERATION_ID, status: "in-progress" } },
      expect: { data: { result: { id: GENERATION_ID, status: "in-progress" }, saved_files: [] } },
    },
    erase_object: multipartCase("/v2beta/stable-image/edit/erase", { image: `${FILE}/desk.png`, mask: `${FILE}/mask.png`, grow_mask: 10 }, { image: "desk.png", mask: "mask.png", grow_mask: "10" }),
    inpaint: multipartCase("/v2beta/stable-image/edit/inpaint", { image: `${FILE}/room.png`, prompt: "A green sofa", mask: `${FILE}/mask.png` }, { image: "room.png", prompt: "A green sofa", mask: "mask.png" }),
    outpaint: multipartCase("/v2beta/stable-image/edit/outpaint", { image: `${FILE}/beach.png`, left: 200, right: 200 }, { image: "beach.png", left: "200", right: "200" }),
    search_and_replace: multipartCase("/v2beta/stable-image/edit/search-and-replace", { image: `${FILE}/dog.png`, prompt: "a golden retriever", search_prompt: "dog" }, { image: "dog.png", prompt: "a golden retriever", search_prompt: "dog" }),
    search_and_recolor: multipartCase("/v2beta/stable-image/edit/search-and-recolor", { image: `${FILE}/car.png`, prompt: "a red car", select_prompt: "car" }, { image: "car.png", prompt: "a red car", select_prompt: "car" }),
    remove_background: multipartCase("/v2beta/stable-image/edit/remove-background", { image: `${FILE}/shoe.jpg`, output_format: "webp" }, { image: "shoe.jpg", output_format: "webp" }),
    control_sketch: multipartCase("/v2beta/stable-image/control/sketch", { image: `${FILE}/sketch.png`, prompt: "A watercolor house", control_strength: 0.8 }, { prompt: "A watercolor house", image: "sketch.png", control_strength: "0.8" }),
    control_structure: multipartCase("/v2beta/stable-image/control/structure", { image: `${FILE}/statue.png`, prompt: "A bronze statue in a garden" }, { prompt: "A bronze statue in a garden", image: "statue.png" }),
    control_style: multipartCase("/v2beta/stable-image/control/style", { image: `${FILE}/style.png`, prompt: "A cat", fidelity: 0.9 }, { prompt: "A cat", image: "style.png", fidelity: "0.9" }),
  },
});

function createRunner(responses, extraEnvironment = {}) {
  const outputDirectory = mkdtempSync(join(tmpdir(), "stability-ai-test-"));
  const recordingFetch = createRecordingFetch(responses);
  const environment = { STABILITY_API_KEY: "sk-test-not-real", STABILITY_AI_OUTPUT_DIR: outputDirectory, GRAPHRT_POLL_INTERVAL_MS: "0", ...extraEnvironment };
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch, resolveHostAddresses: async () => ["93.184.216.34"] });
  return { run, calls: recordingFetch.calls, outputDirectory, cleanUp: () => rmSync(outputDirectory, { recursive: true, force: true }) };
}

test("generate_core streams the image bytes into STABILITY_AI_OUTPUT_DIR", async () => {
  const { run, calls, outputDirectory, cleanUp } = createRunner([{ body: "PNG-BYTES", headers: { "content-type": "image/png" } }]);
  try {
    const { data } = await run("generate_core", { prompt: "A fox" }, { source: "tool" });
    assert.ok(data.path.startsWith(outputDirectory));
    assert.equal(data.content_type, "image/png");
    assert.equal(readFileSync(data.path, "utf8"), "PNG-BYTES");
    assert.equal(calls[0].headers.accept, "image/*");
  } finally {
    cleanUp();
  }
});

test("a synchronous operation without STABILITY_AI_OUTPUT_DIR is refused before any request", async () => {
  const { run, calls, cleanUp } = createRunner([], { STABILITY_AI_OUTPUT_DIR: "" });
  await assert.rejects(run("generate_core", { prompt: "A fox" }, { source: "tool" }), (error) => error.kind === "invalid_input" && error.message.includes("STABILITY_AI_OUTPUT_DIR"));
  assert.equal(calls.length, 0);
  cleanUp();
});

test("upscale_creative polls 202 in-progress until 200 and saves the base64 image", async () => {
  const { run, calls, outputDirectory, cleanUp } = createRunner([
    { body: "INPUT-IMAGE", headers: { "content-type": "image/png" } },
    { body: { id: GENERATION_ID } },
    { status: 202, body: { id: GENERATION_ID, status: "in-progress" } },
    { body: { image: PNG_BYTES.toString("base64"), seed: 5, finish_reason: "SUCCESS" } },
  ]);
  try {
    const { data } = await run("upscale_creative", { image: `${FILE}/a.png`, prompt: "A city" }, { source: "node" });
    assert.equal(data.job_id, GENERATION_ID);
    assert.equal(data.status, "SUCCESS");
    assert.ok(data.saved_files[0].path.startsWith(outputDirectory));
    assert.deepEqual(readFileSync(data.saved_files[0].path), PNG_BYTES);
    assert.equal(calls.filter((call) => call.url.endsWith(`/v2beta/results/${GENERATION_ID}`)).length, 2);
  } finally {
    cleanUp();
  }
});

test("insufficient credits (402) and content moderation (403) map to clear kinds with the API message", async () => {
  const { run, cleanUp } = createRunner([
    { status: 402, body: { id: "e1", name: "payment_required", errors: ["You lack sufficient credits to make this request."] } },
    { status: 403, body: { id: "e2", name: "content_moderation", errors: ["Your request was flagged by our content moderation system"] } },
  ]);
  await assert.rejects(run("get_balance", {}, { source: "tool" }), (error) => error.kind === "permission_denied" && error.message.includes("sufficient credits"));
  await assert.rejects(run("get_balance", {}, { source: "tool" }), (error) => error.kind === "invalid_input" && error.message.includes("content moderation"));
  cleanUp();
});
