import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition, resolveOllamaUrl } from "../definition.mjs";

const LOCAL = "http://127.0.0.1:11434";
const messages = [{ role: "user", content: "Hi" }];

describeRestPluginContract(pluginDefinition, {
  // Without OLLAMA_API_KEY nothing is sent; with it, see the bearer test below.
  checkAuth: (call) => assert.equal(call.headers.authorization, undefined),
  operations: {
    generate: {
      args: { model: "llama3.2", prompt: "Why is the sky blue?", options: { temperature: 0 }, format: { type: "object" } },
      request: {
        method: "POST",
        url: `${LOCAL}/api/generate`,
        query: "absent",
        json: { model: "llama3.2", prompt: "Why is the sky blue?", format: { type: "object" }, options: { temperature: 0 }, stream: false },
      },
      response: { body: { model: "llama3.2", response: "Rayleigh scattering.", done: true } },
      expect: { data: { model: "llama3.2", response: "Rayleigh scattering.", done: true } },
    },
    chat: {
      args: { model: "qwen3:8b", messages, think: false, keep_alive: "10m" },
      request: { method: "POST", url: `${LOCAL}/api/chat`, query: "absent", json: { model: "qwen3:8b", messages, think: false, keep_alive: "10m", stream: false } },
    },
    embed: {
      args: { model: "nomic-embed-text", input: ["a", "b"] },
      request: { method: "POST", url: `${LOCAL}/api/embed`, query: "absent", json: { model: "nomic-embed-text", input: ["a", "b"] } },
    },
    list_models: {
      args: {},
      request: { method: "GET", url: `${LOCAL}/api/tags`, query: "absent" },
      response: { body: { models: [{ name: "llama3.2:latest" }] } },
      expect: { data: [{ name: "llama3.2:latest" }] },
    },
    show_model: {
      args: { model: "llama3.2" },
      request: { method: "POST", url: `${LOCAL}/api/show`, query: "absent", json: { model: "llama3.2" } },
    },
    list_running_models: {
      args: {},
      request: { method: "GET", url: `${LOCAL}/api/ps`, query: "absent" },
    },
    get_version: {
      args: {},
      request: { method: "GET", url: `${LOCAL}/api/version`, query: "absent" },
    },
    pull_model: {
      args: { model: "llama3.2:3b" },
      request: { method: "POST", url: `${LOCAL}/api/pull`, query: "absent", json: { model: "llama3.2:3b", stream: false } },
    },
    copy_model: {
      args: { source: "llama3.2", destination: "llama3.2-backup" },
      request: { method: "POST", url: `${LOCAL}/api/copy`, query: "absent", json: { source: "llama3.2", destination: "llama3.2-backup" } },
    },
    delete_model: {
      args: { model: "llama3.2-backup" },
      request: { method: "DELETE", url: `${LOCAL}/api/delete`, query: "absent", json: { model: "llama3.2-backup" } },
    },
  },
});

test("OLLAMA_URL defaults to the local server and accepts localhost http or remote https", () => {
  assert.equal(resolveOllamaUrl({}), LOCAL);
  assert.equal(resolveOllamaUrl({ OLLAMA_URL: "http://localhost:8080/" }), "http://localhost:8080");
  assert.equal(resolveOllamaUrl({ OLLAMA_URL: "https://ollama.internal.example/proxy/" }), "https://ollama.internal.example/proxy");
  assert.throws(() => resolveOllamaUrl({ OLLAMA_URL: "ftp://host" }));
  assert.throws(() => resolveOllamaUrl({ OLLAMA_URL: "http://localhost:11434/?x=1" }));
});

test("plain http to a remote host is refused before any request", async () => {
  const recordingFetch = createRecordingFetch([{ body: {} }]);
  const run = createOperationRunner(pluginDefinition, { OLLAMA_URL: "http://192.168.1.20:11434" }, { fetchImpl: recordingFetch });
  await assert.rejects(run("list_models", {}, { source: "tool" }), (error) => error.kind === "invalid_input" && /https/.test(error.message));
  assert.equal(recordingFetch.calls.length, 0);
});

test("Ollama's {error} body is shown, e.g. a missing model is not_found", async () => {
  const run = createOperationRunner(pluginDefinition, {}, { fetchImpl: createRecordingFetch([{ status: 404, body: { error: "model 'nope' not found" } }]) });
  await assert.rejects(run("chat", { model: "nope", messages }, { source: "tool" }), (error) => error.kind === "not_found" && error.message.includes("model 'nope' not found"));
});

test("pull, copy and delete are node only; OLLAMA_URL and OLLAMA_API_KEY are the env", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions.env, ["OLLAMA_URL", "OLLAMA_API_KEY"]);
  const toolNames = manifest.tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["pull_model", "copy_model", "delete_model"]) assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
  assert.ok(toolNames.includes("generate"));
});

test("OLLAMA_API_KEY is sent as a bearer token for proxies and redacted from errors", async () => {
  const recordingFetch = createRecordingFetch([{ body: { models: [] } }, { status: 401, body: { error: "bad token proxy-key-0001" } }]);
  const run = createOperationRunner(pluginDefinition, { OLLAMA_URL: "https://ollama.example.com", OLLAMA_API_KEY: "proxy-key-0001" }, { fetchImpl: recordingFetch });
  await run("list_models", {}, { source: "tool" });
  assert.equal(recordingFetch.calls[0].headers.authorization, "Bearer proxy-key-0001");
  await assert.rejects(run("list_models", {}, { source: "tool" }), (error) => error.kind === "auth_error" && !error.message.includes("proxy-key-0001"));
});

test("without OLLAMA_API_KEY no authorization header is sent", async () => {
  const recordingFetch = createRecordingFetch([{ body: { models: [] } }]);
  const run = createOperationRunner(pluginDefinition, {}, { fetchImpl: recordingFetch });
  await run("list_models", {}, { source: "tool" });
  assert.equal(recordingFetch.calls[0].headers.authorization, undefined);
});

test("think accepts a boolean, \"true\"/\"false\" from templates, or a level", async () => {
  for (const [thinkArg, sentValue] of [[true, true], ["false", false], ["high", "high"], ["low", "low"]]) {
    const recordingFetch = createRecordingFetch([{ body: {} }]);
    const run = createOperationRunner(pluginDefinition, {}, { fetchImpl: recordingFetch });
    await run("chat", { model: "gpt-oss", messages, think: thinkArg }, { source: "tool" });
    assert.equal(recordingFetch.calls[0].json.think, sentValue, String(thinkArg));
  }
  const run = createOperationRunner(pluginDefinition, {}, { fetchImpl: createRecordingFetch([]) });
  await assert.rejects(run("generate", { model: "m", prompt: "p", think: "extreme" }, { source: "tool" }), (error) => error.kind === "invalid_input");
});
