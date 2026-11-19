import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.mistral.ai/v1";
const messages = [{ role: "user", content: "Hi" }];
const pdf = { type: "document_url", document_url: "https://example.org/invoice.pdf" };

describeRestPluginContract(pluginDefinition, {
  operations: {
    create_chat_completion: {
      args: { model: "mistral-small-latest", messages, max_tokens: 64, random_seed: 7 },
      request: { method: "POST", url: `${API}/chat/completions`, query: "absent", json: { model: "mistral-small-latest", messages, max_tokens: 64, random_seed: 7, stream: false } },
      response: { body: { choices: [{ message: { content: "Hello" } }] } },
      expect: { data: { choices: [{ message: { content: "Hello" } }] } },
    },
    create_fim_completion: {
      args: { prompt: "def add(a, b):", suffix: "\n\nprint(add(1, 2))" },
      request: { method: "POST", url: `${API}/fim/completions`, query: "absent", json: { model: "codestral-latest", prompt: "def add(a, b):", suffix: "\n\nprint(add(1, 2))", stream: false } },
    },
    create_embeddings: {
      args: { input: ["a", "b"] },
      request: { method: "POST", url: `${API}/embeddings`, query: "absent", json: { model: "mistral-embed", input: ["a", "b"] } },
    },
    moderate_text: {
      args: { input: ["hello"] },
      request: { method: "POST", url: `${API}/moderations`, query: "absent", json: { model: "mistral-moderation-latest", input: ["hello"] } },
    },
    moderate_chat: {
      args: { input: messages },
      request: { method: "POST", url: `${API}/chat/moderations`, query: "absent", json: { model: "mistral-moderation-latest", input: messages } },
    },
    ocr_document: {
      args: { document: pdf, pages: [0, 1], table_format: "markdown" },
      request: { method: "POST", url: `${API}/ocr`, query: "absent", json: { model: "mistral-ocr-latest", document: pdf, pages: [0, 1], include_image_base64: false, table_format: "markdown" } },
      response: { body: { pages: [{ index: 0, markdown: "# Invoice" }], usage_info: { pages_processed: 1 } } },
      expect: { data: { pages: [{ index: 0, markdown: "# Invoice" }], usage_info: { pages_processed: 1 } } },
    },
    list_models: {
      args: {},
      request: { method: "GET", url: `${API}/models`, query: "absent" },
    },
    get_model: {
      args: { model_id: "mistral-small-latest" },
      request: { method: "GET", url: `${API}/models/mistral-small-latest`, query: "absent" },
    },
    list_files: {
      args: { purpose: "batch", limit: 50, cursor: "2" },
      request: { method: "GET", url: `${API}/files`, query: { purpose: "batch", page: "2", page_size: "50" } },
    },
    upload_file: {
      args: { file: "https://files.contract.example/batch.jsonl", purpose: "batch" },
      request: { method: "POST", url: `${API}/files`, query: "absent", multipart: { file: "batch.jsonl", purpose: "batch" } },
    },
    get_file: {
      args: { file_id: "f-1" },
      request: { method: "GET", url: `${API}/files/f-1`, query: "absent" },
    },
    download_file_content: {
      args: { file_id: "f-out" },
      request: { method: "GET", url: `${API}/files/f-out/content`, query: "absent" },
    },
    delete_file: {
      args: { file_id: "f-1" },
      request: { method: "DELETE", url: `${API}/files/f-1`, query: "absent", body: "absent" },
    },
    create_batch_job: {
      args: { endpoint: "/v1/chat/completions", model: "mistral-small-latest", input_files: ["f-1"] },
      request: { method: "POST", url: `${API}/batch/jobs`, query: "absent", json: { endpoint: "/v1/chat/completions", model: "mistral-small-latest", input_files: ["f-1"] } },
    },
    get_batch_job: {
      args: { job_id: "job-1" },
      request: { method: "GET", url: `${API}/batch/jobs/job-1`, query: "absent" },
    },
    list_batch_jobs: {
      args: { status: ["RUNNING", "QUEUED"] },
      request: { method: "GET", url: `${API}/batch/jobs`, query: { status: ["RUNNING", "QUEUED"] } },
    },
    cancel_batch_job: {
      args: { job_id: "job-1" },
      request: { method: "POST", url: `${API}/batch/jobs/job-1/cancel`, query: "absent", body: "absent" },
    },
  },
});

function createRunner(responses) {
  const recordingFetch = createRecordingFetch(responses);
  return { run: createOperationRunner(pluginDefinition, { MISTRAL_API_KEY: "mistral-test-0001" }, { fetchImpl: recordingFetch }), calls: recordingFetch.calls };
}

test("deletes and cancels are not agent tools", () => {
  const toolNames = buildManifest(pluginDefinition).tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["delete_file", "cancel_batch_job"]) assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
});

test("pages start at 0 and a full page has a next cursor", async () => {
  const { run } = createRunner([{ body: { data: [{ id: "a" }, { id: "b" }], total: 5 } }]);
  const firstPage = await run("list_files", { limit: 2 }, { source: "tool" });
  assert.equal(firstPage.next_cursor, "1");
});

test("401 {message: Unauthorized} is an auth_error and 422 validation details are shown", async () => {
  const unauthorized = createRunner([{ status: 401, body: { message: "Unauthorized", request_id: "r1" } }]);
  await assert.rejects(unauthorized.run("list_models", {}, { source: "tool" }), (error) => error.kind === "auth_error" && error.message.includes("Unauthorized"));
  const invalid = createRunner([{ status: 422, body: { object: "error", message: { detail: [{ msg: "Field required", loc: ["body", "model"] }] }, type: "invalid_request_error" } }]);
  await assert.rejects(invalid.run("moderate_text", { input: ["x"] }, { source: "tool" }), (error) => error.kind === "invalid_input" && error.message.includes("Field required"));
});

test("paid calls are never retried after a 5xx and say how to check", async () => {
  for (const [operationName, args] of [
    ["create_chat_completion", { model: "mistral-small-latest", messages }],
    ["create_fim_completion", { prompt: "def f():" }],
    ["create_embeddings", { input: ["a"] }],
    ["moderate_text", { input: ["a"] }],
    ["moderate_chat", { input: messages }],
    ["ocr_document", { document: pdf }],
  ]) {
    const { run, calls } = createRunner([{ status: 500, headers: { "retry-after": "0" }, body: {} }, { body: {} }]);
    await assert.rejects(run(operationName, args, { source: "tool" }), (error) => error.retryable === false && /outcome unknown/.test(error.message) && /usage/.test(error.message), operationName);
    assert.equal(calls.length, 1, operationName);
  }
});

test("create_batch_job needs MISTRAL_TOOL_ALLOW_BATCH=1 as an agent tool", async () => {
  const { run, calls } = createRunner([]);
  await assert.rejects(run("create_batch_job", { endpoint: "/v1/chat/completions" }, { source: "tool" }), (error) => error.kind === "permission_denied" && /MISTRAL_TOOL_ALLOW_BATCH/.test(error.message));
  assert.equal(calls.length, 0);
});
