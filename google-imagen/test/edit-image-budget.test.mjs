import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createEditImageOperation, MAX_INLINE_REQUEST_BYTES } from "../lib/edit-image.mjs";
import { pluginDefinition } from "../definition.mjs";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An edit_image operation with a tiny time budget and a fake create_interaction that records its calls. */
function createBudgetedOperation({ hostTimeoutMs, generationTimeoutMs }) {
  const interactionCalls = [];
  const createInteractionOperation = { run: async (context) => (interactionCalls.push(context.args), { data: { ok: true }, next_cursor: null }) };
  const operation = createEditImageOperation({
    createInteractionOperation,
    uploadDirEnv: "GOOGLE_IMAGEN_UPLOAD_DIR",
    defaultModel: "m",
    aspectRatios: ["1:1"],
    imageSizes: ["1K"],
    limits: { timeout_ms: hostTimeoutMs },
    generationTimeoutMs,
  });
  return { operation, interactionCalls };
}

function contextWithFetch(fetchImpl) {
  return { args: { prompt: "x", images: ["https://cdn.example.com/a.png"], model: "m" }, environment: {}, source: "tool", client: { fetchImpl, resolveHostAddresses: async () => ["93.184.216.34"] } };
}

test("a slow input download is aborted at the read budget and nothing is sent to Google", async () => {
  // Host 15 060 ms - 15 000 ms job margin - 0 ms generation = 60 ms to read the inputs.
  const { operation, interactionCalls } = createBudgetedOperation({ hostTimeoutMs: 15060, generationTimeoutMs: 0 });
  // AbortSignal.timeout timers do not keep the event loop alive (the plugin's stdin does); a guard timer does here.
  const hangingFetch = (url, init) =>
    new Promise((resolve, reject) => {
      const guardTimer = setTimeout(() => reject(new Error("the read budget did not abort the download")), 5000);
      init.signal.addEventListener("abort", () => (clearTimeout(guardTimer), reject(init.signal.reason)));
    });
  const startedAt = Date.now();
  await assert.rejects(operation.run(contextWithFetch(hangingFetch)), (error) => error.kind === "timeout" && /input images/.test(error.message));
  assert.ok(Date.now() - startedAt < 2000, "aborted promptly");
  assert.equal(interactionCalls.length, 0);
});

test("create_interaction is refused (not retryable) when reading left too little time for the generation", async () => {
  const { operation, interactionCalls } = createBudgetedOperation({ hostTimeoutMs: 15040, generationTimeoutMs: 0 });
  // Ignores the abort signal and answers after the 40 ms read budget.
  const slowFetch = () => new Promise((resolve) => setTimeout(() => resolve(new Response(PNG_HEADER, { headers: { "content-type": "image/png" } })), 120));
  await assert.rejects(operation.run(contextWithFetch(slowFetch)), (error) => error.retryable === false && /too little time/.test(error.message));
  assert.equal(interactionCalls.length, 0);
});

test("inputs within the time budget go to create_interaction", async () => {
  const { operation, interactionCalls } = createBudgetedOperation({ hostTimeoutMs: 60000, generationTimeoutMs: 10000 });
  const quickFetch = async () => new Response(PNG_HEADER, { headers: { "content-type": "image/png" } });
  await operation.run(contextWithFetch(quickFetch));
  assert.equal(interactionCalls.length, 1);
  assert.equal(interactionCalls[0].input[1].mime_type, "image/png");
});

test("the inline request limit (20 MB with base64 and prompt) is enforced before sending", async () => {
  assert.equal(MAX_INLINE_REQUEST_BYTES, 20 * 1000 * 1000);
  const { operation, interactionCalls } = createBudgetedOperation({ hostTimeoutMs: 60000, generationTimeoutMs: 10000 });
  const bigImage = Buffer.concat([PNG_HEADER, Buffer.alloc(8 * 1000 * 1000)]);
  const bigFetch = async () => new Response(bigImage, { headers: { "content-type": "image/png" } });
  const context = { ...contextWithFetch(bigFetch), args: { prompt: "x", images: ["https://cdn.example.com/a.png", "https://cdn.example.com/b.png"], model: "m" } };
  await assert.rejects(operation.run(context), (error) => error.kind === "invalid_input" && /20 MB/.test(error.message));
  assert.equal(interactionCalls.length, 0);
});

function runPlugin(operationName, args, responses) {
  const outputDirectory = mkdtempSync(join(tmpdir(), "google-imagen-budget-"));
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { GEMINI_API_KEY: "gemini-test-not-real", GOOGLE_IMAGEN_OUTPUT_DIR: outputDirectory }, { fetchImpl: recordingFetch });
  return { promise: run(operationName, args, { source: "node" }), calls: recordingFetch.calls, cleanUp: () => rmSync(outputDirectory, { recursive: true, force: true }) };
}

test("get_model strips a leading models/ prefix", async () => {
  const { promise, calls, cleanUp } = runPlugin("get_model", { model: "models/gemini-3-pro-image" }, [{ body: { name: "models/gemini-3-pro-image" } }]);
  await promise;
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image");
  cleanUp();
});

test("interim thought images are saved to files too, so no base64 stays in the result", async () => {
  const thoughtImage = Buffer.concat([PNG_HEADER, Buffer.from("thought")]).toString("base64");
  const finalImage = Buffer.concat([PNG_HEADER, Buffer.from("final")]).toString("base64");
  const body = {
    id: "v1",
    steps: [
      { type: "thought", summary: [{ type: "text", text: "Trying a layout" }, { type: "image", mime_type: "image/png", data: thoughtImage }] },
      { type: "model_output", content: [{ type: "image", mime_type: "image/png", data: finalImage }] },
    ],
  };
  const { promise, cleanUp } = runPlugin("generate_image", { prompt: "x" }, [{ body }]);
  try {
    const { data } = await promise;
    assert.equal(data.saved_files.length, 2);
    assert.match(data.result.steps[0].summary[1].data, /^\[saved to /);
    assert.match(data.result.steps[1].content[0].data, /^\[saved to /);
  } finally {
    cleanUp();
  }
});
