import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.deepgram.com";

describeRestPluginContract(pluginDefinition, {
  operations: {
    transcribe_url: {
      args: { url: "https://dpgr.am/spacewalk.wav", diarize: true, redact: ["pii", "pci"], keyterm: ["graphrt"] },
      request: {
        method: "POST",
        url: `${API}/v1/listen`,
        query: { model: "nova-3", smart_format: "true", diarize: "true", keyterm: "graphrt", redact: ["pii", "pci"] },
        json: { url: "https://dpgr.am/spacewalk.wav" },
      },
      response: { body: { metadata: { request_id: "r1" }, results: { channels: [{ alternatives: [{ transcript: "hello" }] }] } } },
      expect: { data: { metadata: { request_id: "r1" }, results: { channels: [{ alternatives: [{ transcript: "hello" }] }] } } },
    },
    transcribe_file: {
      args: { file: "https://files.contract.example/call.wav", language: "id", keyterm: ["graphrt"] },
      request: {
        method: "POST",
        url: `${API}/v1/listen`,
        query: { model: "nova-3", language: "id", smart_format: "true", keyterm: "graphrt" },
        file: { contentType: "application/octet-stream" },
      },
    },
    text_to_speech: {
      args: { text: "Halo", encoding: "linear16", container: "wav", sample_rate: 24000 },
      request: { method: "POST", url: `${API}/v1/speak`, query: { model: "aura-2-thalia-en", encoding: "linear16", container: "wav", sample_rate: "24000" }, json: { text: "Halo" } },
    },
    analyze_text: {
      args: { text: "The meeting went well.", summarize: true, sentiment: true },
      request: { method: "POST", url: `${API}/v1/read`, query: { language: "en", summarize: "true", sentiment: "true" }, json: { text: "The meeting went well." } },
    },
    list_models: {
      args: { include_outdated: true },
      request: { method: "GET", url: `${API}/v1/models`, query: { include_outdated: "true" } },
    },
    get_model: {
      args: { model_id: "30089e05-99d1-4376-b32e-c263170674af" },
      request: { method: "GET", url: `${API}/v1/models/30089e05-99d1-4376-b32e-c263170674af`, query: "absent" },
    },
    list_projects: {
      args: {},
      request: { method: "GET", url: `${API}/v1/projects`, query: "absent" },
      response: { body: { projects: [{ project_id: "p1", name: "Main" }] } },
      expect: { data: [{ project_id: "p1", name: "Main" }] },
    },
    get_project_balances: {
      args: { project_id: "p1" },
      request: { method: "GET", url: `${API}/v1/projects/p1/balances`, query: "absent" },
      response: { body: { balances: [{ balance_id: "b1", amount: 199.5, units: "usd" }] } },
      expect: { data: [{ balance_id: "b1", amount: 199.5, units: "usd" }] },
    },
    list_project_requests: {
      args: { project_id: "p1", endpoint: "listen", status: "failed", limit: 25 },
      request: { method: "GET", url: `${API}/v1/projects/p1/requests`, query: { endpoint: "listen", status: "failed", limit: "25" } },
      response: { body: { page: 0, limit: 25, requests: [{ request_id: "r1" }] } },
      expect: { data: [{ request_id: "r1" }] },
    },
  },
});

test("the key is sent as Authorization: Token <key>", async () => {
  const recordingFetch = createRecordingFetch([{ body: { projects: [] } }]);
  const run = createOperationRunner(pluginDefinition, { DEEPGRAM_API_KEY: "dg-key-0001" }, { fetchImpl: recordingFetch });
  await run("list_projects", {}, { source: "tool" });
  assert.equal(recordingFetch.calls[0].headers.authorization, "Token dg-key-0001");
});

test("INVALID_AUTH becomes auth_error with Deepgram's message", async () => {
  const recordingFetch = createRecordingFetch([{ status: 401, body: { err_code: "INVALID_AUTH", err_msg: "Invalid credentials.", request_id: "x" } }]);
  const run = createOperationRunner(pluginDefinition, { DEEPGRAM_API_KEY: "dg-key-0001" }, { fetchImpl: recordingFetch });
  await assert.rejects(run("list_models", {}, { source: "node" }), (error) => error.kind === "auth_error" && error.message.includes("Invalid credentials. (INVALID_AUTH)"));
});
