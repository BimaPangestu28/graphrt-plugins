import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner, buildManifest } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.openai.com/v1";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describeRestPluginContract(pluginDefinition, {
  operations: {
    list_models: {
      args: {},
      request: { method: "GET", url: `${API}/models`, query: "absent" },
      response: { body: { object: "list", data: [{ id: "gpt-image-2" }] } },
      expect: { data: [{ id: "gpt-image-2" }] },
    },
    generate_image: {
      args: { prompt: "A lighthouse at dawn", size: "1536x1024", quality: "high", output_format: "webp" },
      request: {
        method: "POST",
        url: `${API}/images/generations`,
        query: "absent",
        json: { prompt: "A lighthouse at dawn", model: "gpt-image-2", size: "1536x1024", quality: "high", output_format: "webp" },
      },
    },
    edit_image: {
      args: { image: "https://files.contract.example/room.png", mask: "https://files.contract.example/mask.png", prompt: "Add a sofa", n: 2 },
      request: {
        method: "POST",
        url: `${API}/images/edits`,
        query: "absent",
        multipart: { image: "room.png", mask: "mask.png", prompt: "Add a sofa", model: "gpt-image-2", n: "2" },
      },
    },
    edit_image_from_references: {
      args: { images: [{ image_url: "https://example.com/a.png" }, { file_id: "file-1" }], prompt: "Put both products in one gift basket", input_fidelity: "high", model: "gpt-image-1.5" },
      request: {
        method: "POST",
        url: `${API}/images/edits`,
        query: "absent",
        json: { images: [{ image_url: "https://example.com/a.png" }, { file_id: "file-1" }], prompt: "Put both products in one gift basket", model: "gpt-image-1.5", input_fidelity: "high" },
      },
    },
  },
});

function runWithOutputDirectory(operationName, args, responses) {
  const outputDirectory = mkdtempSync(join(tmpdir(), "openai-images-test-"));
  const recordingFetch = createRecordingFetch(responses);
  const environment = { OPENAI_API_KEY: "sk-test-not-real", OPENAI_IMAGES_OUTPUT_DIR: outputDirectory };
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch, resolveHostAddresses: async () => ["93.184.216.34"] });
  return { outputDirectory, calls: recordingFetch.calls, resultPromise: run(operationName, args, { source: "tool" }) };
}

test("generate_image saves b64_json as a png file and replaces the blob in the result", async () => {
  const b64 = PNG_BYTES.toString("base64");
  const { outputDirectory, resultPromise } = runWithOutputDirectory("generate_image", { prompt: "cat" }, [{ body: { created: 1, data: [{ b64_json: b64 }], usage: { total_tokens: 10 } } }]);
  try {
    const { data } = await resultPromise;
    const [savedFile] = data.saved_files;
    assert.equal(savedFile.content_type, "image/png");
    assert.ok(savedFile.path.startsWith(outputDirectory) && savedFile.path.endsWith(".png"));
    assert.deepEqual(readFileSync(savedFile.path), PNG_BYTES);
    assert.equal(data.result.data[0].b64_json, `[saved to ${savedFile.path}]`);
    assert.equal(data.result.usage.total_tokens, 10);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("a moderation block maps to invalid_input with OpenAI's message", async () => {
  const { resultPromise, outputDirectory } = runWithOutputDirectory("generate_image", { prompt: "x" }, [
    { status: 400, body: { error: { message: "Your request was rejected by the safety system.", type: "image_generation_user_error", code: "moderation_blocked" } } },
  ]);
  await assert.rejects(resultPromise, (error) => error.kind === "invalid_input" && error.message.includes("safety system"));
  rmSync(outputDirectory, { recursive: true, force: true });
});

test("an exhausted quota is permission_denied, not a retryable rate limit", async () => {
  const { resultPromise, calls, outputDirectory } = runWithOutputDirectory("list_models", {}, [
    { status: 429, body: { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } } },
  ]);
  await assert.rejects(resultPromise, (error) => error.kind === "permission_denied");
  assert.equal(calls.length, 1);
  rmSync(outputDirectory, { recursive: true, force: true });
});

test("local upload paths are refused unless OPENAI_IMAGES_UPLOAD_DIR is set", async () => {
  const { resultPromise, calls, outputDirectory } = runWithOutputDirectory("edit_image", { image: "/etc/hosts", prompt: "x" }, []);
  await assert.rejects(resultPromise, (error) => error.kind === "invalid_input" && error.message.includes("OPENAI_IMAGES_UPLOAD_DIR"));
  assert.equal(calls.length, 0);
  rmSync(outputDirectory, { recursive: true, force: true });
});

test("manifest declares the key, the output and upload directories", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions.env.sort(), ["OPENAI_API_KEY", "OPENAI_IMAGES_OUTPUT_DIR", "OPENAI_IMAGES_UPLOAD_DIR"]);
  assert.equal(manifest.permissions.secrets, true);
});
