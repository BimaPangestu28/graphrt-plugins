import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.anthropic.com/v1";
const messages = [{ role: "user", content: "Hi" }];
const versionHeader = { "anthropic-version": "2026-10-21" };

describeRestPluginContract(pluginDefinition, {
  operations: {
    create_message: {
      args: { messages, system: "Be brief.", output_config: { effort: "low" } },
      request: {
        method: "POST",
        url: `${API}/messages`,
        query: "absent",
        headers: versionHeader,
        json: { model: "claude-opus-5-5", max_tokens: 16000, messages, system: "Be brief.", output_config: { effort: "low" } },
      },
      response: { body: { id: "msg_1", content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn" } },
      expect: { data: { id: "msg_1", content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn" } },
    },
    count_tokens: {
      args: { model: "claude-haiku-5-5", messages },
      request: { method: "POST", url: `${API}/messages/count_tokens`, query: "absent", json: { model: "claude-haiku-5-5", messages } },
    },
    list_models: {
      args: { limit: 20 },
      request: { method: "GET", url: `${API}/models`, query: { limit: "20" }, headers: versionHeader },
      response: { body: { data: [{ id: "claude-opus-5-5" }], has_more: false, last_id: "claude-opus-5-5" } },
      expect: { data: [{ id: "claude-opus-5-5" }] },
    },
    get_model: {
      args: { model_id: "claude-opus-5-5" },
      request: { method: "GET", url: `${API}/models/claude-opus-5-5`, query: "absent" },
    },
    create_message_batch: {
      args: { requests: [{ custom_id: "a", params: { model: "claude-haiku-5-5", max_tokens: 100, messages } }] },
      request: {
        method: "POST",
        url: `${API}/messages/batches`,
        query: "absent",
        json: { requests: [{ custom_id: "a", params: { model: "claude-haiku-5-5", max_tokens: 100, messages } }] },
      },
    },
    get_message_batch: {
      args: { batch_id: "msgbatch_1" },
      request: { method: "GET", url: `${API}/messages/batches/msgbatch_1`, query: "absent" },
    },
    list_message_batches: {
      args: { cursor: "msgbatch_0" },
      request: { method: "GET", url: `${API}/messages/batches`, query: { after_id: "msgbatch_0" } },
    },
    cancel_message_batch: {
      args: { batch_id: "msgbatch_1" },
      request: { method: "POST", url: `${API}/messages/batches/msgbatch_1/cancel`, query: "absent", body: "absent" },
    },
    delete_message_batch: {
      args: { batch_id: "msgbatch_1" },
      request: { method: "DELETE", url: `${API}/messages/batches/msgbatch_1`, query: "absent", body: "absent" },
    },
    upload_file: {
      args: { file: "https://files.contract.example/report.pdf" },
      request: { method: "POST", url: `${API}/files`, query: "absent", multipart: { file: "report.pdf" } },
    },
    list_files: {
      args: {},
      request: { method: "GET", url: `${API}/files`, query: "absent" },
    },
    get_file: {
      args: { file_id: "file_1" },
      request: { method: "GET", url: `${API}/files/file_1`, query: "absent" },
    },
    delete_file: {
      args: { file_id: "file_1" },
      request: { method: "DELETE", url: `${API}/files/file_1`, query: "absent", body: "absent" },
    },
  },
});

test("create_message offers no sampling params (refused by API version 2026-10-21)", () => {
  const createMessage = buildManifest(pluginDefinition).tools.find((tool) => tool.name === "create_message");
  for (const removedParam of ["temperature", "top_p", "top_k"]) assert.equal(removedParam in createMessage.parameters.properties, false, removedParam);
});

test("cancels and deletes are not agent tools", () => {
  const toolNames = buildManifest(pluginDefinition).tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["cancel_message_batch", "delete_message_batch", "delete_file"]) assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
});

test("list_models pages with last_id as after_id while has_more is true", async () => {
  const recordingFetch = createRecordingFetch([{ body: { data: [{ id: "m1" }, { id: "m2" }], has_more: true, last_id: "m2" } }, { body: { data: [{ id: "m3" }], has_more: false, last_id: "m3" } }]);
  const run = createOperationRunner(pluginDefinition, { ANTHROPIC_API_KEY: "sk-ant-test-0001" }, { fetchImpl: recordingFetch });
  const firstPage = await run("list_models", {}, { source: "tool" });
  assert.equal(firstPage.next_cursor, "m2");
  const lastPage = await run("list_models", { cursor: firstPage.next_cursor }, { source: "tool" });
  assert.equal(recordingFetch.calls[1].query.after_id, "m2");
  assert.equal(lastPage.next_cursor, null);
});

test("an overloaded 529 is retried, an authentication_error is not", async () => {
  const overloadedFetch = createRecordingFetch([{ status: 529, headers: { "retry-after": "0" }, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }, { body: { id: "msg_2" } }]);
  const run = createOperationRunner(pluginDefinition, { ANTHROPIC_API_KEY: "sk-ant-test-0001" }, { fetchImpl: overloadedFetch });
  assert.deepEqual((await run("create_message", { messages }, { source: "tool" })).data, { id: "msg_2" });
  const authFetch = createRecordingFetch([{ status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }]);
  const authRun = createOperationRunner(pluginDefinition, { ANTHROPIC_API_KEY: "sk-ant-bad" }, { fetchImpl: authFetch });
  await assert.rejects(authRun("list_models", {}, { source: "tool" }), (error) => error.kind === "auth_error" && error.message.includes("invalid x-api-key"));
  assert.equal(authFetch.calls.length, 1);
});

test("create_message is never retried after a 5xx (it may have been billed) and says how to check", async () => {
  const recordingFetch = createRecordingFetch([{ status: 500, headers: { "retry-after": "0" }, body: { type: "error", error: { type: "api_error", message: "Internal" } } }, { body: {} }]);
  const run = createOperationRunner(pluginDefinition, { ANTHROPIC_API_KEY: "sk-ant-test-0001" }, { fetchImpl: recordingFetch });
  await assert.rejects(run("create_message", { messages }, { source: "tool" }), (error) => error.retryable === false && /outcome unknown/.test(error.message) && /usage/.test(error.message));
  assert.equal(recordingFetch.calls.length, 1);
});

test("count_tokens (free) is still retried after a 5xx", async () => {
  const recordingFetch = createRecordingFetch([{ status: 500, headers: { "retry-after": "0" }, body: {} }, { body: { input_tokens: 3 } }]);
  const run = createOperationRunner(pluginDefinition, { ANTHROPIC_API_KEY: "sk-ant-test-0001" }, { fetchImpl: recordingFetch });
  assert.deepEqual((await run("count_tokens", { messages }, { source: "tool" })).data, { input_tokens: 3 });
});

test("create_message_batch needs ANTHROPIC_TOOL_ALLOW_BATCH=1 as an agent tool", async () => {
  const run = createOperationRunner(pluginDefinition, { ANTHROPIC_API_KEY: "sk-ant-test-0001" }, { fetchImpl: createRecordingFetch([]) });
  await assert.rejects(run("create_message_batch", { requests: [{ custom_id: "a", params: {} }] }, { source: "tool" }), (error) => error.kind === "permission_denied" && /ANTHROPIC_TOOL_ALLOW_BATCH/.test(error.message));
});
