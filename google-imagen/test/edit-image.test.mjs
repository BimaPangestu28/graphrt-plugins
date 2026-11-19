import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

function createRunner(responses, extraEnvironment = {}) {
  const outputDirectory = mkdtempSync(join(tmpdir(), "google-imagen-out-"));
  const recordingFetch = createRecordingFetch(responses);
  const environment = { GEMINI_API_KEY: "gemini-test-not-real", GOOGLE_IMAGEN_OUTPUT_DIR: outputDirectory, ...extraEnvironment };
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch, resolveHostAddresses: async () => ["93.184.216.34"] });
  return { run, calls: recordingFetch.calls, outputDirectory, cleanUp: () => rmSync(outputDirectory, { recursive: true, force: true }) };
}

const finishedInteraction = (imageBytes) => ({
  id: "v1_abc",
  status: "completed",
  steps: [{ type: "model_output", content: [{ type: "text", text: "Here you go" }, { type: "image", mime_type: "image/png", data: imageBytes.toString("base64") }] }],
});

test("edit_image is listed as a node and a tool with its own schema", () => {
  const manifest = buildManifest(pluginDefinition);
  const tool = manifest.tools.find((candidate) => candidate.name === "edit_image");
  assert.ok(tool, "edit_image tool");
  assert.deepEqual(tool.parameters.required.sort(), ["images", "prompt"]);
  assert.ok(manifest.nodes.some((node) => node.kind === "google-imagen.edit_image"));
  assert.ok(manifest.permissions.env.includes("GOOGLE_IMAGEN_UPLOAD_DIR"));
});

test("edit_image inlines the images as base64 blocks after the prompt and saves the result", async () => {
  const { run, calls, outputDirectory, cleanUp } = createRunner([
    { body: "JPEG", headers: { "content-type": "image/jpeg" } },
    { body: finishedInteraction(PNG_BYTES) },
  ]);
  try {
    const { data } = await run("edit_image", { prompt: "Put a hat on the cat", images: ["https://cdn.example.com/cat.jpg"], aspect_ratio: "16:9", image_size: "2K" }, { source: "tool" });
    const interactionCall = calls[1];
    assert.equal(interactionCall.url, INTERACTIONS_URL);
    assert.equal(interactionCall.headers["api-revision"], "2026-05-20");
    assert.equal(interactionCall.headers["x-goog-api-key"], "gemini-test-not-real");
    assert.deepEqual(interactionCall.json, {
      input: [
        { type: "text", text: "Put a hat on the cat" },
        { type: "image", mime_type: "image/jpeg", data: Buffer.from("JPEG").toString("base64") },
      ],
      model: "gemini-nano-banana-2.1",
      response_format: { type: "image", aspect_ratio: "16:9", image_size: "2K" },
    });
    const [savedFile] = data.saved_files;
    assert.ok(savedFile.path.startsWith(outputDirectory));
    assert.deepEqual(readFileSync(savedFile.path), PNG_BYTES);
    assert.equal(calls[0].headers["x-goog-api-key"], undefined, "the image download carries no key");
  } finally {
    cleanUp();
  }
});

test("edit_image reads local images inside GOOGLE_IMAGEN_UPLOAD_DIR and sniffs their type", async () => {
  const uploadDirectory = mkdtempSync(join(tmpdir(), "google-imagen-in-"));
  const localImage = join(uploadDirectory, "photo.bin");
  writeFileSync(localImage, JPEG_BYTES);
  const { run, calls, cleanUp } = createRunner([{ body: finishedInteraction(PNG_BYTES) }], { GOOGLE_IMAGEN_UPLOAD_DIR: uploadDirectory });
  try {
    await run("edit_image", { prompt: "Brighter", images: [localImage] }, { source: "node" });
    assert.deepEqual(calls[0].json.input[1], { type: "image", mime_type: "image/jpeg", data: JPEG_BYTES.toString("base64") });
    assert.deepEqual(calls[0].json.response_format, { type: "image" });
  } finally {
    cleanUp();
    rmSync(uploadDirectory, { recursive: true, force: true });
  }
});

test("edit_image refuses local paths without GOOGLE_IMAGEN_UPLOAD_DIR before any request", async () => {
  const { run, calls, cleanUp } = createRunner([]);
  await assert.rejects(run("edit_image", { prompt: "x", images: ["/etc/hosts"] }, { source: "tool" }), (error) => error.kind === "invalid_input" && error.message.includes("GOOGLE_IMAGEN_UPLOAD_DIR"));
  assert.equal(calls.length, 0);
  cleanUp();
});

test("edit_image refuses an input that is not an image", async () => {
  const { run, calls, cleanUp } = createRunner([{ body: "%PDF-1.7", headers: { "content-type": "application/pdf" } }]);
  await assert.rejects(run("edit_image", { prompt: "x", images: ["https://cdn.example.com/doc.pdf"] }, { source: "tool" }), (error) => error.kind === "invalid_input" && error.message.includes("images[0]"));
  assert.equal(calls.length, 1, "only the download, no interaction");
  cleanUp();
});

test("edit_image refuses more than 14 images and an empty list", async () => {
  const { run, calls, cleanUp } = createRunner([]);
  const tooMany = Array.from({ length: 15 }, (unused, index) => `https://cdn.example.com/${index}.png`);
  await assert.rejects(run("edit_image", { prompt: "x", images: tooMany }, { source: "tool" }), (error) => error.kind === "invalid_input");
  await assert.rejects(run("edit_image", { prompt: "x", images: [] }, { source: "tool" }), (error) => error.kind === "invalid_input");
  assert.equal(calls.length, 0);
  cleanUp();
});

test("edit_image errors keep the unknown-outcome note of the interaction write", async () => {
  const { run, cleanUp } = createRunner([
    { body: "PNG", headers: { "content-type": "image/png" } },
    { status: 500, body: { error: { code: "api_error", message: "Internal error" } } },
  ]);
  await assert.rejects(run("edit_image", { prompt: "x", images: ["https://cdn.example.com/a.png"] }, { source: "tool" }), (error) => error.retryable === false && /outcome unknown/.test(error.message));
  cleanUp();
});
