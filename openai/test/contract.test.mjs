import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner, buildManifest } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.openai.com/v1";

describeRestPluginContract(pluginDefinition, {
  operations: {
    create_response: {
      args: { model: "gpt-5-mini", input: "Summarize: graphrt runs graphs", reasoning_effort: "low", text_format: { type: "text" }, max_output_tokens: 200 },
      request: {
        method: "POST",
        url: `${API}/responses`,
        query: "absent",
        json: { model: "gpt-5-mini", input: "Summarize: graphrt runs graphs", max_output_tokens: 200, reasoning: { effort: "low" }, text: { format: { type: "text" } }, store: false },
      },
      response: { body: { id: "resp_1", output: [{ type: "message", content: [{ type: "output_text", text: "It runs graphs." }] }] } },
      expect: { data: { id: "resp_1", output: [{ type: "message", content: [{ type: "output_text", text: "It runs graphs." }] }] } },
    },
    get_response: {
      args: { response_id: "resp_1" },
      request: { method: "GET", url: `${API}/responses/resp_1`, query: "absent" },
    },
    delete_response: {
      args: { response_id: "resp_1" },
      request: { method: "DELETE", url: `${API}/responses/resp_1`, query: "absent", body: "absent" },
    },
    create_chat_completion: {
      args: { model: "gpt-5-mini", messages: [{ role: "user", content: "Hi" }], response_format: { type: "json_object" }, stop: ["END"] },
      request: {
        method: "POST",
        url: `${API}/chat/completions`,
        query: "absent",
        json: { model: "gpt-5-mini", messages: [{ role: "user", content: "Hi" }], response_format: { type: "json_object" }, stop: ["END"], stream: false },
      },
    },
    create_embeddings: {
      args: { model: "text-embedding-3-small", input: ["a", "b"], dimensions: 256 },
      request: { method: "POST", url: `${API}/embeddings`, query: "absent", json: { model: "text-embedding-3-small", input: ["a", "b"], dimensions: 256 } },
    },
    create_moderation: {
      args: { input: "hello" },
      request: { method: "POST", url: `${API}/moderations`, query: "absent", json: { input: "hello", model: "omni-moderation-latest" } },
    },
    list_models: {
      args: {},
      request: { method: "GET", url: `${API}/models`, query: "absent" },
      response: { body: { object: "list", data: [{ id: "gpt-5-mini" }] } },
      expect: { data: [{ id: "gpt-5-mini" }] },
    },
    get_model: {
      args: { model: "gpt-5-mini" },
      request: { method: "GET", url: `${API}/models/gpt-5-mini`, query: "absent" },
    },
    list_files: {
      args: { purpose: "batch", limit: 20 },
      request: { method: "GET", url: `${API}/files`, query: { purpose: "batch", limit: "20" } },
      response: { body: { data: [{ id: "file-1" }], has_more: true } },
      expect: { data: [{ id: "file-1" }] },
    },
    upload_file: {
      args: { file: "https://files.contract.example/requests.jsonl", purpose: "batch" },
      request: { method: "POST", url: `${API}/files`, query: "absent", multipart: { file: "requests.jsonl", purpose: "batch" } },
    },
    get_file: {
      args: { file_id: "file-1" },
      request: { method: "GET", url: `${API}/files/file-1`, query: "absent" },
    },
    download_file_content: {
      args: { file_id: "file-out" },
      request: { method: "GET", url: `${API}/files/file-out/content`, query: "absent" },
    },
    delete_file: {
      args: { file_id: "file-1" },
      request: { method: "DELETE", url: `${API}/files/file-1`, query: "absent", body: "absent" },
    },
    create_batch: {
      args: { input_file_id: "file-1", endpoint: "/v1/responses" },
      request: { method: "POST", url: `${API}/batches`, query: "absent", json: { input_file_id: "file-1", endpoint: "/v1/responses", completion_window: "24h" } },
    },
    get_batch: {
      args: { batch_id: "batch_1" },
      request: { method: "GET", url: `${API}/batches/batch_1`, query: "absent" },
    },
    list_batches: {
      args: { limit: 5 },
      request: { method: "GET", url: `${API}/batches`, query: { limit: "5" } },
    },
    cancel_batch: {
      args: { batch_id: "batch_1" },
      request: { method: "POST", url: `${API}/batches/batch_1/cancel`, query: "absent", body: "absent" },
    },
  },
});

async function runOperation(operationName, args, responses, source = "tool") {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { OPENAI_API_KEY: "sk-test-0001" }, { fetchImpl: recordingFetch });
  return { result: await run(operationName, args, { source }), calls: recordingFetch.calls };
}

test("deletes and batch cancellation are not agent tools", () => {
  const toolNames = buildManifest(pluginDefinition).tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["delete_response", "delete_file", "cancel_batch"]) assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
  assert.ok(toolNames.includes("create_response"));
});

test("list_files pages with the last file id as `after`", async () => {
  const { result } = await runOperation("list_files", {}, [{ body: { data: [{ id: "file-1" }, { id: "file-2" }], has_more: true } }]);
  assert.equal(result.next_cursor, "file-2");
  const nextPage = await runOperation("list_files", { cursor: "file-2" }, [{ body: { data: [], has_more: false } }]);
  assert.equal(new URL(nextPage.calls[0].url).searchParams.get("after"), "file-2");
  assert.equal(nextPage.result.next_cursor, null);
});

test("invalid_api_key becomes auth_error and insufficient_quota is not retried", async () => {
  await assert.rejects(
    runOperation("list_models", {}, [{ status: 401, body: { error: { message: "Incorrect API key provided", code: "invalid_api_key" } } }]),
    (error) => error.kind === "auth_error" && error.message.includes("Incorrect API key"),
  );
  const quotaFetch = createRecordingFetch([{ status: 429, body: { error: { message: "You exceeded your current quota", code: "insufficient_quota" } } }, { body: {} }]);
  const run = createOperationRunner(pluginDefinition, { OPENAI_API_KEY: "sk-test-0001" }, { fetchImpl: quotaFetch });
  await assert.rejects(run("list_models", {}, { source: "tool" }), (error) => error.kind === "permission_denied" && error.retryable === false);
  assert.equal(quotaFetch.calls.length, 1);
});

test("paid calls are never retried after a 5xx or timeout, and say how to check", async () => {
  for (const [operationName, args] of [
    ["create_response", { model: "gpt-5-mini", input: "hi" }],
    ["create_chat_completion", { model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }] }],
    ["create_embeddings", { model: "text-embedding-3-small", input: ["a"] }],
  ]) {
    const recordingFetch = createRecordingFetch([{ status: 500, headers: { "retry-after": "0" }, body: {} }, { body: {} }]);
    const run = createOperationRunner(pluginDefinition, { OPENAI_API_KEY: "sk-test-0001" }, { fetchImpl: recordingFetch });
    await assert.rejects(run(operationName, args, { source: "tool" }), (error) => error.retryable === false && /outcome unknown/.test(error.message) && /usage/.test(error.message), operationName);
    assert.equal(recordingFetch.calls.length, 1, operationName);
  }
});

test("free moderation is still retried after a 5xx", async () => {
  const { calls } = await runOperation("create_moderation", { input: "hi" }, [{ status: 500, headers: { "retry-after": "0" }, body: {} }, { body: {} }]);
  assert.equal(calls.length, 2);
});

test("create_batch needs OPENAI_TOOL_ALLOW_BATCH=1 as an agent tool", async () => {
  await assert.rejects(runOperation("create_batch", { input_file_id: "file-1", endpoint: "/v1/responses" }, []), (error) => error.kind === "permission_denied" && /OPENAI_TOOL_ALLOW_BATCH/.test(error.message));
  const { calls } = await runOperation("create_batch", { input_file_id: "file-1", endpoint: "/v1/responses" }, [{ body: { id: "batch_1" } }], "node");
  assert.equal(calls.length, 1);
});

const remoteToolArgs = (toolType) => ({ model: "gpt-5-mini", input: "hi", tools: [{ type: "function", name: "f" }, { type: toolType, server_url: "https://mcp.example.com" }] });

test("create_response refuses mcp and connector tools from agent tools unless OPENAI_TOOL_ALLOW_REMOTE_TOOLS=1", async () => {
  for (const toolType of ["mcp", "connector"]) {
    const recordingFetch = createRecordingFetch([{ body: {} }]);
    const run = createOperationRunner(pluginDefinition, { OPENAI_API_KEY: "sk-test-0001" }, { fetchImpl: recordingFetch });
    await assert.rejects(run("create_response", remoteToolArgs(toolType), { source: "tool" }), (error) => error.kind === "permission_denied" && /OPENAI_TOOL_ALLOW_REMOTE_TOOLS/.test(error.message), toolType);
    assert.equal(recordingFetch.calls.length, 0);
  }
  const allowedFetch = createRecordingFetch([{ body: {} }]);
  const allowedRun = createOperationRunner(pluginDefinition, { OPENAI_API_KEY: "sk-test-0001", OPENAI_TOOL_ALLOW_REMOTE_TOOLS: "1" }, { fetchImpl: allowedFetch });
  await allowedRun("create_response", remoteToolArgs("mcp"), { source: "tool" });
  assert.equal(allowedFetch.calls.length, 1);
});

test("nodes may use mcp tools, and agents may use other tool types", async () => {
  const { calls } = await runOperation("create_response", remoteToolArgs("mcp"), [{ body: {} }], "node");
  assert.equal(calls[0].json.tools[1].type, "mcp");
  const webSearch = await runOperation("create_response", { model: "gpt-5-mini", input: "hi", tools: [{ type: "web_search" }] }, [{ body: {} }]);
  assert.equal(webSearch.calls.length, 1);
});
