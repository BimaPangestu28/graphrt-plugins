import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.ideogram.ai/v2";
const FILE = "https://files.contract.example";
const post = (path, args, multipart, query = "absent") => ({ args, request: { method: "POST", url: `${API}${path}`, query, multipart } });

describeRestPluginContract(pluginDefinition, {
  operations: {
    generate_image: post("/image/generate/ideogram-4-5", { prompt: "A poster that says GRAPHRT", quality: "medium", size: "1024x1024", num_images: 2 }, { prompt: "A poster that says GRAPHRT", quality: "medium", size: "1024x1024", num_images: "2" }),
    generate_image_v3: post(
      "/image/generate/ideogram-3",
      { prompt: "A fox logo", rendering_speed: "TURBO", style_type: "DESIGN", style_reference_image: `${FILE}/style.png`, dry_run: true },
      { prompt: "A fox logo", rendering_speed: "TURBO", style_type: "DESIGN", style_reference_images: "style.png" },
      { dry_run: "true" },
    ),
    remix_image: post("/image/remix/ideogram-3", { prompt: "Make it winter", image: `${FILE}/house.jpg`, image_weight: 60 }, { prompt: "Make it winter", image: "house.jpg", image_weight: "60" }),
    precise_edit: post(
      "/image/precise-edit/ideogram-4-5",
      { prompt: "Change the shoes to slate-blue knit", image: `${FILE}/shoes.png`, mask: `${FILE}/mask.png`, reference_image: `${FILE}/knit.png`, quality: "low" },
      { prompt: "Change the shoes to slate-blue knit", image: "shoes.png", mask: "mask.png", reference_images: "knit.png", quality: "low" },
    ),
    inpaint_image: post("/image/inpaint/ideogram-3", { prompt: "A vase of tulips", image: `${FILE}/table.png`, mask: `${FILE}/mask.png` }, { prompt: "A vase of tulips", image: "table.png", mask: "mask.png" }),
    reframe_image: post("/image/reframe/ideogram-3", { image: `${FILE}/square.png`, resolution: "1536x640" }, { image: "square.png", resolution: "1536x640" }),
    upscale_image: post("/image/upscale/auto", { image: `${FILE}/small.png`, upscale_factor: "4x" }, { image: "small.png", upscale_factor: "4x" }),
    remove_background: post("/image/remove-background/ideogram-1", { image: `${FILE}/product.jpg`, private: true }, { image: "product.jpg", private: "true" }),
    describe_image: {
      args: { image: `${FILE}/poster.png`, include_tags: true },
      request: { method: "POST", url: `${API}/image/describe/ideogram-4`, query: "absent", multipart: { image: "poster.png", include_tags: "true" } },
      response: { body: { description_id: "d1", json_prompt: { subjects: [] } } },
      expect: { data: { description_id: "d1", json_prompt: { subjects: [] } } },
    },
    get_generation: { args: { generation_id: "Z2VuLTE" }, request: { method: "GET", url: `${API}/generations/Z2VuLTE`, query: "absent" } },
    get_usage: {
      args: { start_time: "2026-11-01T00:00:00Z", bucket_width: "1h", sources: ["api"] },
      request: { method: "GET", url: `${API}/account/usage`, query: { start_time: "2026-11-01T00:00:00Z", bucket_width: "1h", sources: "api" } },
      response: { body: { buckets: [{ start_time: "2026-11-01T00:00:00Z", cost_usd: 0.06 }] } },
      expect: { data: [{ start_time: "2026-11-01T00:00:00Z", cost_usd: 0.06 }] },
    },
  },
});

function createRunner(responses) {
  const outputDirectory = mkdtempSync(join(tmpdir(), "ideogram-test-"));
  const recordingFetch = createRecordingFetch(responses);
  const environment = { IDEOGRAM_API_KEY: "ideogram-test-not-real", IDEOGRAM_OUTPUT_DIR: outputDirectory };
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch, resolveHostAddresses: async () => ["93.184.216.34"] });
  return { run, calls: recordingFetch.calls, outputDirectory, cleanUp: () => rmSync(outputDirectory, { recursive: true, force: true }) };
}

test("generate_image sends Api-Key, downloads every image URL and keeps unsafe images listed", async () => {
  const { run, calls, outputDirectory, cleanUp } = createRunner([
    { body: { generation_id: "g1", seed: 3, data: [{ url: "https://ideogram.ai/api/images/ephemeral/a.png", is_image_safe: true }, { url: null, is_image_safe: false }] } },
    { body: "PNG-A", headers: { "content-type": "image/png" } },
  ]);
  try {
    const { data } = await run("generate_image", { prompt: "A sign" }, { source: "tool" });
    assert.equal(calls[0].headers["api-key"], "ideogram-test-not-real");
    assert.equal(data.saved_files.length, 2);
    assert.deepEqual(data.saved_files[1], { image_index: 1, url: null, filtered: true });
    assert.ok(data.saved_files[0].path.startsWith(outputDirectory));
    assert.equal(readFileSync(data.saved_files[0].path, "utf8"), "PNG-A");
    assert.equal(data.result.data[1].is_image_safe, false);
  } finally {
    cleanUp();
  }
});

test("402 insufficient_funds is permission_denied with Ideogram's message", async () => {
  const { run, cleanUp } = createRunner([{ status: 402, body: { error: "Your API balance is empty.", reject_reason: "insufficient_funds" } }]);
  await assert.rejects(run("generate_image", { prompt: "x" }, { source: "tool" }), (error) => error.kind === "permission_denied" && error.message.includes("balance is empty"));
  cleanUp();
});

test("a remove_background failure reported in a 200 body is an error", async () => {
  const { run, cleanUp } = createRunner([
    { body: "IMG", headers: { "content-type": "image/png" } },
    { body: { error: "Background removal failed", status_code: 500 } },
  ]);
  await assert.rejects(run("remove_background", { image: `${FILE}/p.png` }, { source: "tool" }), (error) => error.message.includes("Background removal failed"));
  cleanUp();
});

test("dry_run returns the price quote without any download", async () => {
  const { run, calls, cleanUp } = createRunner([{ body: "IMG" }, { body: { price_usd: 0.06, currency: "USD" } }]);
  try {
    const { data } = await run("remix_image", { prompt: "x", image: `${FILE}/a.png`, dry_run: true }, { source: "tool" });
    assert.deepEqual(data, { result: { price_usd: 0.06, currency: "USD" }, saved_files: [] });
    assert.equal(calls.length, 2);
  } finally {
    cleanUp();
  }
});

test("safety-filtered images (url empty or null) are not downloaded and are reported as filtered", async () => {
  const { run, calls, cleanUp } = createRunner([
    {
      body: {
        generation_id: "g2",
        seed: 1,
        data: [
          { url: "https://ideogram.ai/api/images/ephemeral/ok.png", is_image_safe: true, seed: 1 },
          { url: "", is_image_safe: false, seed: 2 },
          { url: null, is_image_safe: false, seed: 3 },
        ],
      },
    },
    { body: "PNG-OK", headers: { "content-type": "image/png" } },
  ]);
  try {
    const { data } = await run("generate_image_v3", { prompt: "A sign" }, { source: "tool" });
    assert.equal(calls.length, 2, "one generation, one download");
    assert.equal(data.saved_files.length, 3);
    assert.ok(data.saved_files[0].path);
    assert.deepEqual(data.saved_files.slice(1), [{ image_index: 1, url: null, filtered: true }, { image_index: 2, url: null, filtered: true }]);
    assert.equal(data.saved_files.some((savedFile) => savedFile.error), false);
  } finally {
    cleanUp();
  }
});
