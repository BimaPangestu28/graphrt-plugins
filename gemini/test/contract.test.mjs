import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://generativelanguage.googleapis.com/v1beta";
const contents = [{ role: "user", parts: [{ text: "Hi" }] }];

describeRestPluginContract(pluginDefinition, {
  operations: {
    generate_content: {
      args: { model: "gemini-2.5-flash", contents, system_instruction: { parts: [{ text: "Be brief" }] }, generation_config: { maxOutputTokens: 100 } },
      request: {
        method: "POST",
        url: `${API}/models/gemini-2.5-flash:generateContent`,
        query: "absent",
        json: { contents, systemInstruction: { parts: [{ text: "Be brief" }] }, generationConfig: { maxOutputTokens: 100 } },
      },
      response: { body: { candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }] } },
      expect: { data: { candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }] } },
    },
    count_tokens: {
      args: { model: "gemini-2.5-flash", contents },
      request: { method: "POST", url: `${API}/models/gemini-2.5-flash:countTokens`, query: "absent", json: { contents } },
    },
    embed_content: {
      args: { model: "gemini-embedding-001", content: { parts: [{ text: "a" }] }, task_type: "RETRIEVAL_QUERY", output_dimensionality: 768 },
      request: {
        method: "POST",
        url: `${API}/models/gemini-embedding-001:embedContent`,
        query: "absent",
        json: { content: { parts: [{ text: "a" }] }, taskType: "RETRIEVAL_QUERY", outputDimensionality: 768 },
      },
    },
    batch_embed_contents: {
      args: { model: "gemini-embedding-001", requests: [{ model: "models/gemini-embedding-001", content: { parts: [{ text: "a" }] } }] },
      request: {
        method: "POST",
        url: `${API}/models/gemini-embedding-001:batchEmbedContents`,
        query: "absent",
        json: { requests: [{ model: "models/gemini-embedding-001", content: { parts: [{ text: "a" }] } }] },
      },
    },
    list_models: {
      args: { limit: 50 },
      request: { method: "GET", url: `${API}/models`, query: { pageSize: "50" } },
      response: { body: { models: [{ name: "models/gemini-2.5-flash" }], nextPageToken: "p2" } },
      expect: { data: [{ name: "models/gemini-2.5-flash" }] },
    },
    get_model: {
      args: { model: "gemini-2.5-flash" },
      request: { method: "GET", url: `${API}/models/gemini-2.5-flash`, query: "absent" },
    },
    list_files: {
      args: { cursor: "p2" },
      request: { method: "GET", url: `${API}/files`, query: { pageToken: "p2" } },
    },
    get_file: {
      args: { file_id: "abc123" },
      request: { method: "GET", url: `${API}/files/abc123`, query: "absent" },
    },
    delete_file: {
      args: { file_id: "abc123" },
      request: { method: "DELETE", url: `${API}/files/abc123`, query: "absent", body: "absent" },
    },
  },
});

test("an invalid API key (400 INVALID_ARGUMENT with reason API_KEY_INVALID) is an auth_error", async () => {
  const invalidKeyBody = { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }] } };
  const run = createOperationRunner(pluginDefinition, { GEMINI_API_KEY: "bad-key-0001" }, { fetchImpl: createRecordingFetch([{ status: 400, body: invalidKeyBody }]) });
  await assert.rejects(run("list_models", {}, { source: "tool" }), (error) => error.kind === "auth_error" && error.message.includes("API key not valid"));
});

test("a plain 400 without an ErrorInfo reason stays invalid_input", async () => {
  const run = createOperationRunner(pluginDefinition, { GEMINI_API_KEY: "key-0001" }, { fetchImpl: createRecordingFetch([{ status: 400, body: { error: { code: 400, message: "Invalid JSON payload", status: "INVALID_ARGUMENT" } } }]) });
  await assert.rejects(run("count_tokens", { model: "gemini-2.5-flash", contents }, { source: "tool" }), (error) => error.kind === "invalid_input");
});

test("a model id with a models/ prefix stays one segment instead of changing the path", async () => {
  const recordingFetch = createRecordingFetch([{ body: {} }]);
  const run = createOperationRunner(pluginDefinition, { GEMINI_API_KEY: "key-0001" }, { fetchImpl: recordingFetch });
  await run("get_model", { model: "models/gemini-2.5-flash" }, { source: "tool" });
  assert.equal(recordingFetch.calls[0].path, "/v1beta/models/models%2Fgemini-2.5-flash");
});

test("delete_file is node only and upload_file reads GEMINI_UPLOAD_DIR", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.equal(manifest.tools.some((tool) => tool.name === "delete_file"), false);
  assert.deepEqual(manifest.permissions.env, ["GEMINI_API_KEY", "GEMINI_UPLOAD_DIR", "GEMINI_TOOL_ALLOW_URL_CONTEXT"]);
});

function createRunner(environment, responses) {
  const recordingFetch = createRecordingFetch(responses);
  return { run: createOperationRunner(pluginDefinition, { GEMINI_API_KEY: "key-0001", ...environment }, { fetchImpl: recordingFetch }), calls: recordingFetch.calls };
}

test("paid calls are never retried after a 5xx and say how to check; countTokens still is", async () => {
  const serverError = { status: 500, headers: { "retry-after": "0" }, body: { error: { code: 500, message: "Internal error" } } };
  for (const [operationName, args] of [
    ["generate_content", { model: "gemini-2.5-flash", contents }],
    ["embed_content", { model: "gemini-embedding-001", content: { parts: [{ text: "a" }] } }],
    ["batch_embed_contents", { model: "gemini-embedding-001", requests: [{ content: { parts: [{ text: "a" }] } }] }],
  ]) {
    const { run, calls } = createRunner({}, [serverError, { body: {} }]);
    await assert.rejects(run(operationName, args, { source: "tool" }), (error) => error.retryable === false && /outcome unknown/.test(error.message) && /billed/.test(error.message), operationName);
    assert.equal(calls.length, 1, operationName);
  }
  const counting = createRunner({}, [serverError, { body: { totalTokens: 2 } }]);
  assert.deepEqual((await counting.run("count_tokens", { model: "gemini-2.5-flash", contents }, { source: "tool" })).data, { totalTokens: 2 });
});

test("generate_content refuses the urlContext tool from agents unless GEMINI_TOOL_ALLOW_URL_CONTEXT=1", async () => {
  for (const urlTool of [{ urlContext: {} }, { url_context: {} }]) {
    const { run, calls } = createRunner({}, [{ body: {} }]);
    await assert.rejects(run("generate_content", { model: "gemini-2.5-flash", contents, tools: [{ googleSearch: {} }, urlTool] }, { source: "tool" }), (error) => error.kind === "permission_denied" && /GEMINI_TOOL_ALLOW_URL_CONTEXT/.test(error.message));
    assert.equal(calls.length, 0);
  }
  const allowed = createRunner({ GEMINI_TOOL_ALLOW_URL_CONTEXT: "1" }, [{ body: {} }]);
  await allowed.run("generate_content", { model: "gemini-2.5-flash", contents, tools: [{ urlContext: {} }] }, { source: "tool" });
  assert.equal(allowed.calls.length, 1);
  const asNode = createRunner({}, [{ body: {} }]);
  await asNode.run("generate_content", { model: "gemini-2.5-flash", contents, tools: [{ urlContext: {} }] }, { source: "node" });
  assert.equal(asNode.calls.length, 1);
});
