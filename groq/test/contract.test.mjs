import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.groq.com/openai/v1";
const messages = [{ role: "user", content: "Hi" }];

describeRestPluginContract(pluginDefinition, {
  operations: {
    create_chat_completion: {
      args: { model: "llama-3.3-70b-versatile", messages, max_completion_tokens: 50, response_format: { type: "json_object" } },
      request: {
        method: "POST",
        url: `${API}/chat/completions`,
        query: "absent",
        json: { model: "llama-3.3-70b-versatile", messages, max_completion_tokens: 50, response_format: { type: "json_object" }, stream: false },
      },
      response: { body: { choices: [{ message: { role: "assistant", content: "{}" } }] } },
      expect: { data: { choices: [{ message: { role: "assistant", content: "{}" } }] } },
    },
    list_models: {
      args: {},
      request: { method: "GET", url: `${API}/models`, query: "absent" },
      response: { body: { object: "list", data: [{ id: "llama-3.3-70b-versatile" }] } },
      expect: { data: [{ id: "llama-3.3-70b-versatile" }] },
    },
    get_model: {
      args: { model: "openai/gpt-oss-120b" },
      request: { method: "GET", url: `${API}/models/openai%2Fgpt-oss-120b`, query: "absent" },
    },
    transcribe_audio: {
      args: { file: "https://files.contract.example/call.mp3", language: "id" },
      request: {
        method: "POST",
        url: `${API}/audio/transcriptions`,
        query: "absent",
        multipart: { file: "call.mp3", model: "whisper-large-v3-turbo", response_format: "json", language: "id" },
      },
    },
    translate_audio: {
      args: { url: "https://example.org/talk.mp3" },
      request: { method: "POST", url: `${API}/audio/translations`, query: "absent", multipart: { url: "https://example.org/talk.mp3", model: "whisper-large-v3", response_format: "json" } },
    },
    create_speech: {
      args: { model: "tts-model", input: "Hello", voice: "voice-1" },
      request: { method: "POST", url: `${API}/audio/speech`, query: "absent", json: { model: "tts-model", input: "Hello", voice: "voice-1", response_format: "wav" } },
    },
    list_files: {
      args: {},
      request: { method: "GET", url: `${API}/files`, query: "absent" },
    },
    upload_file: {
      args: { file: "https://files.contract.example/batch.jsonl" },
      request: { method: "POST", url: `${API}/files`, query: "absent", multipart: { file: "batch.jsonl", purpose: "batch" } },
    },
    get_file: {
      args: { file_id: "file_1" },
      request: { method: "GET", url: `${API}/files/file_1`, query: "absent" },
    },
    download_file_content: {
      args: { file_id: "file_out" },
      request: { method: "GET", url: `${API}/files/file_out/content`, query: "absent" },
    },
    delete_file: {
      args: { file_id: "file_1" },
      request: { method: "DELETE", url: `${API}/files/file_1`, query: "absent", body: "absent" },
    },
    create_batch: {
      args: { input_file_id: "file_1", completion_window: "48h" },
      request: { method: "POST", url: `${API}/batches`, query: "absent", json: { input_file_id: "file_1", endpoint: "/v1/chat/completions", completion_window: "48h" } },
    },
    get_batch: {
      args: { batch_id: "batch_1" },
      request: { method: "GET", url: `${API}/batches/batch_1`, query: "absent" },
    },
    list_batches: {
      args: {},
      request: { method: "GET", url: `${API}/batches`, query: "absent" },
    },
    cancel_batch: {
      args: { batch_id: "batch_1" },
      request: { method: "POST", url: `${API}/batches/batch_1/cancel`, query: "absent", body: "absent" },
    },
  },
});

test("deletes and batch cancellation are not agent tools", () => {
  const toolNames = buildManifest(pluginDefinition).tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["delete_file", "cancel_batch"]) assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
});

test("an invalid key is an auth_error with Groq's message", async () => {
  const run = createOperationRunner(pluginDefinition, { GROQ_API_KEY: "gsk_bad_0001" }, { fetchImpl: createRecordingFetch([{ status: 401, body: { error: { message: "Invalid API Key", type: "invalid_request_error", code: "invalid_api_key" } } }]) });
  await assert.rejects(run("list_models", {}, { source: "tool" }), (error) => error.kind === "auth_error" && error.message.includes("Invalid API Key"));
});

test("audio files over 25 MB are refused before upload", () => {
  const transcribe = pluginDefinition.restSpec.operations.find((operation) => operation.name === "transcribe_audio");
  assert.equal(transcribe.multipart.maxFileBytes, 25 * 1024 * 1024);
});

function createRunner(environment, responses) {
  const recordingFetch = createRecordingFetch(responses);
  return { run: createOperationRunner(pluginDefinition, { GROQ_API_KEY: "gsk_test_0001", GROQ_OUTPUT_DIR: "/tmp/groq-test-out", ...environment }, { fetchImpl: recordingFetch }), calls: recordingFetch.calls };
}

test("paid calls are never retried after a 5xx and say how to check", async () => {
  for (const [operationName, args] of [
    ["create_chat_completion", { model: "llama-3.3-70b-versatile", messages }],
    ["transcribe_audio", { url: "https://example.org/a.mp3" }],
    ["translate_audio", { url: "https://example.org/a.mp3" }],
    ["create_speech", { model: "tts", input: "hi", voice: "v" }],
  ]) {
    const { run, calls } = createRunner({}, [{ status: 500, headers: { "retry-after": "0" }, body: {} }, { body: {} }]);
    await assert.rejects(run(operationName, args, { source: "tool" }), (error) => error.retryable === false && /outcome unknown/.test(error.message) && /usage/.test(error.message), operationName);
    assert.equal(calls.length, 1, operationName);
  }
});

test("create_batch needs GROQ_TOOL_ALLOW_BATCH=1 as an agent tool", async () => {
  const { run, calls } = createRunner({}, []);
  await assert.rejects(run("create_batch", { input_file_id: "file_1" }, { source: "tool" }), (error) => error.kind === "permission_denied" && /GROQ_TOOL_ALLOW_BATCH/.test(error.message));
  assert.equal(calls.length, 0);
});
