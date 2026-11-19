import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://generativelanguage.googleapis.com/v1beta";
const REVISION = { "api-revision": "2026-05-20" };

describeRestPluginContract(pluginDefinition, {
  operations: {
    list_models: {
      args: {},
      request: { method: "GET", url: `${API}/models`, query: "absent" },
      response: { body: { models: [{ name: "models/gemini-nano-banana-2.1" }] } },
      expect: { data: [{ name: "models/gemini-nano-banana-2.1" }] },
    },
    get_model: { args: { model: "gemini-3-pro-image" }, request: { method: "GET", url: `${API}/models/gemini-3-pro-image`, query: "absent" } },
    generate_image: {
      args: { prompt: "A nano banana dish in a fancy restaurant", aspect_ratio: "16:9", image_size: "2K" },
      request: {
        method: "POST",
        url: `${API}/interactions`,
        query: "absent",
        headers: REVISION,
        json: { input: "A nano banana dish in a fancy restaurant", model: "gemini-nano-banana-2.1", response_format: { type: "image", aspect_ratio: "16:9", image_size: "2K" } },
      },
    },
    create_interaction: {
      args: { input: [{ type: "text", text: "Make it night" }], previous_interaction_id: "v1_prev", model: "gemini-3-pro-image", response_format: { type: "image" } },
      request: {
        method: "POST",
        url: `${API}/interactions`,
        query: "absent",
        headers: REVISION,
        json: { input: [{ type: "text", text: "Make it night" }], model: "gemini-3-pro-image", response_format: { type: "image" }, previous_interaction_id: "v1_prev" },
      },
    },
    get_interaction: { args: { interaction_id: "v1_abc" }, request: { method: "GET", url: `${API}/interactions/v1_abc`, query: "absent", headers: REVISION } },
    delete_interaction: { args: { interaction_id: "v1_abc" }, request: { method: "DELETE", url: `${API}/interactions/v1_abc`, query: "absent", body: "absent" } },
  },
});

async function runOperation(operationName, args, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { GEMINI_API_KEY: "gemini-test-not-real" }, { fetchImpl: recordingFetch });
  return run(operationName, args, { source: "tool" });
}

test("an invalid API key (400 API_KEY_INVALID) is an auth_error", async () => {
  const body = { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }] } };
  await assert.rejects(runOperation("list_models", {}, [{ status: 400, body }]), (error) => error.kind === "auth_error" && error.message.includes("API key not valid"));
});

test("an array-wrapped Interactions error still shows its message", async () => {
  const body = [{ error: { code: 400, message: "Unsupported aspect ratio", status: "INVALID_ARGUMENT" } }];
  await assert.rejects(runOperation("get_interaction", { interaction_id: "x" }, [{ status: 400, body }]), (error) => error.kind === "invalid_input" && error.message.includes("Unsupported aspect ratio"));
});

test("a generation without GOOGLE_IMAGEN_OUTPUT_DIR keeps the base64 but tool output is truncated", async () => {
  const bigImage = "A".repeat(60000);
  const { data } = await runOperation("generate_image", { prompt: "x" }, [{ body: { id: "v1", steps: [{ type: "model_output", content: [{ type: "image", data: bigImage }] }] } }]);
  assert.equal(data.truncated, true);
  assert.ok(data.preview.length <= 20000);
});

test("delete_interaction is node only", async () => {
  await assert.rejects(runOperation("delete_interaction", { interaction_id: "v1" }, []), (error) => error.kind === "invalid_input" && /Unknown operation/.test(error.message));
});
