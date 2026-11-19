import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition, resolveDeeplUrl } from "../definition.mjs";

const API = "https://api.deepl.com";

describeRestPluginContract(pluginDefinition, {
  operations: {
    translate_text: {
      args: { text: ["Selamat pagi"], target_lang: "EN-US", formality: "prefer_less", context: "A greeting in an email" },
      request: { method: "POST", url: `${API}/v2/translate`, query: "absent", json: { text: ["Selamat pagi"], target_lang: "EN-US", context: "A greeting in an email", formality: "prefer_less" } },
      response: { body: { translations: [{ detected_source_language: "ID", text: "Good morning" }] } },
      expect: { data: { translations: [{ detected_source_language: "ID", text: "Good morning" }] } },
    },
    rephrase_text: {
      args: { text: ["me and him goes to the shop"], writing_style: "business" },
      request: { method: "POST", url: `${API}/v2/write/rephrase`, query: "absent", json: { text: ["me and him goes to the shop"], writing_style: "business" } },
    },
    get_usage: {
      args: {},
      request: { method: "GET", url: `${API}/v2/usage`, query: "absent" },
      response: { body: { character_count: 180, character_limit: 500000 } },
      expect: { data: { character_count: 180, character_limit: 500000 } },
    },
    list_languages: {
      args: { type: "source" },
      request: { method: "GET", url: `${API}/v2/languages`, query: { type: "source" } },
    },
    list_glossaries: {
      args: {},
      request: { method: "GET", url: `${API}/v3/glossaries`, query: "absent" },
      response: { body: { glossaries: [{ glossary_id: "g1", name: "Brand" }] } },
      expect: { data: [{ glossary_id: "g1", name: "Brand" }] },
    },
    get_glossary: {
      args: { glossary_id: "g1" },
      request: { method: "GET", url: `${API}/v3/glossaries/g1`, query: "absent" },
    },
    get_glossary_entries: {
      args: { glossary_id: "g1", source_lang: "EN", target_lang: "DE" },
      request: { method: "GET", url: `${API}/v3/glossaries/g1/entries`, query: { source_lang: "EN", target_lang: "DE" } },
    },
    translate_document: {
      args: { file: "https://files.contract.example/contract.docx", target_lang: "DE" },
      request: { method: "POST", url: `${API}/v2/document`, query: "absent", multipart: { file: "contract.docx", target_lang: "DE" } },
    },
    get_document_status: {
      args: { document_id: "doc1", document_key: "key1" },
      request: { method: "POST", url: `${API}/v2/document/doc1`, query: "absent", json: { document_key: "key1" } },
    },
    download_document: {
      args: { document_id: "doc1", document_key: "key1" },
      request: { method: "POST", url: `${API}/v2/document/doc1/result`, query: "absent", json: { document_key: "key1" } },
    },
  },
});

test("free-plan keys (ending in :fx) use api-free.deepl.com", () => {
  assert.equal(resolveDeeplUrl({ DEEPL_API_KEY: "abc:fx" }), "https://api-free.deepl.com");
  assert.equal(resolveDeeplUrl({ DEEPL_API_KEY: "abc" }), "https://api.deepl.com");
  assert.equal(resolveDeeplUrl({ DEEPL_API_KEY: "abc", DEEPL_API_URL: "https://api-free.deepl.com/" }), "https://api-free.deepl.com");
});

test("the key is sent as DeepL-Auth-Key, never in the URL", async () => {
  const recordingFetch = createRecordingFetch([{ body: {} }]);
  const run = createOperationRunner(pluginDefinition, { DEEPL_API_KEY: "secret-0001:fx" }, { fetchImpl: recordingFetch });
  await run("get_usage", {}, { source: "tool" });
  assert.equal(recordingFetch.calls[0].url, "https://api-free.deepl.com/v2/usage");
  assert.equal(recordingFetch.calls[0].headers.authorization, "DeepL-Auth-Key secret-0001:fx");
});

test("DEEPL_API_URL must stay on deepl.com", async () => {
  const run = createOperationRunner(pluginDefinition, { DEEPL_API_KEY: "k", DEEPL_API_URL: "https://evil.example.com" }, { fetchImpl: createRecordingFetch([]) });
  await assert.rejects(run("get_usage", {}, { source: "tool" }), (error) => error.kind === "invalid_input");
});

test("a wrong key (403) is an auth_error and an exhausted quota (456) is not retried", async () => {
  const forbidden = createOperationRunner(pluginDefinition, { DEEPL_API_KEY: "bad" }, { fetchImpl: createRecordingFetch([{ status: 403, body: { message: "Authorization failure, check auth_key" } }]) });
  await assert.rejects(forbidden("get_usage", {}, { source: "tool" }), (error) => error.kind === "auth_error" && error.message.includes("Authorization failure"));
  const quotaFetch = createRecordingFetch([{ status: 456, body: { message: "Quota exceeded" } }, { body: {} }]);
  const quota = createOperationRunner(pluginDefinition, { DEEPL_API_KEY: "k" }, { fetchImpl: quotaFetch });
  await assert.rejects(quota("translate_text", { text: ["a"], target_lang: "DE" }, { source: "tool" }), (error) => error.kind === "permission_denied" && error.retryable === false);
  assert.equal(quotaFetch.calls.length, 1);
});

test("translate_text and rephrase_text are never retried after a 5xx (characters may have been billed)", async () => {
  for (const [operationName, args] of [["translate_text", { text: ["a"], target_lang: "DE" }], ["rephrase_text", { text: ["a"] }]]) {
    const recordingFetch = createRecordingFetch([{ status: 500, headers: { "retry-after": "0" }, body: { message: "Internal" } }, { body: {} }]);
    const run = createOperationRunner(pluginDefinition, { DEEPL_API_KEY: "k" }, { fetchImpl: recordingFetch });
    await assert.rejects(run(operationName, args, { source: "tool" }), (error) => error.retryable === false && /outcome unknown/.test(error.message) && /get_usage/.test(error.message), operationName);
    assert.equal(recordingFetch.calls.length, 1, operationName);
  }
});

test("get_document_status (free) is still retried after a 5xx", async () => {
  const recordingFetch = createRecordingFetch([{ status: 500, headers: { "retry-after": "0" }, body: {} }, { body: { status: "done" } }]);
  const run = createOperationRunner(pluginDefinition, { DEEPL_API_KEY: "k" }, { fetchImpl: recordingFetch });
  assert.deepEqual((await run("get_document_status", { document_id: "d", document_key: "k1" }, { source: "tool" })).data, { status: "done" });
});
