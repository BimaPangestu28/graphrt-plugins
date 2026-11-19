import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://translation.googleapis.com/language/translate/v2";

describeRestPluginContract(pluginDefinition, {
  operations: {
    translate_text: {
      args: { text: ["Selamat pagi", "Terima kasih"], target: "en" },
      request: { method: "POST", url: API, query: "absent", json: { q: ["Selamat pagi", "Terima kasih"], target: "en", format: "text" } },
      response: { body: { data: { translations: [{ translatedText: "Good morning", detectedSourceLanguage: "id" }, { translatedText: "Thank you", detectedSourceLanguage: "id" }] } } },
      expect: { data: [{ translatedText: "Good morning", detectedSourceLanguage: "id" }, { translatedText: "Thank you", detectedSourceLanguage: "id" }] },
    },
    detect_language: {
      args: { text: ["Bonjour"] },
      request: { method: "POST", url: `${API}/detect`, query: "absent", json: { q: ["Bonjour"] } },
      response: { body: { data: { detections: [[{ language: "fr", confidence: 1 }]] } } },
      expect: { data: [[{ language: "fr", confidence: 1 }]] },
    },
    list_languages: {
      args: { display_language: "id" },
      request: { method: "GET", url: `${API}/languages`, query: { target: "id" } },
      response: { body: { data: { languages: [{ language: "en", name: "Inggris" }] } } },
      expect: { data: [{ language: "en", name: "Inggris" }] },
    },
  },
});

function createRunner(responses) {
  const recordingFetch = createRecordingFetch(responses);
  return { run: createOperationRunner(pluginDefinition, { GOOGLE_TRANSLATE_API_KEY: "key-0001" }, { fetchImpl: recordingFetch }), calls: recordingFetch.calls };
}

test("the API key goes in the x-goog-api-key header, not the URL", async () => {
  const { run, calls } = createRunner([{ body: { data: { languages: [] } } }]);
  await run("list_languages", {}, { source: "tool" });
  assert.equal(calls[0].headers["x-goog-api-key"], "key-0001");
  assert.equal(calls[0].url.includes("key-0001"), false);
});

test("API_KEY_INVALID (a 400) is an auth_error; a disabled API is permission_denied", async () => {
  const invalid = createRunner([{ status: 400, body: { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } } }]);
  await assert.rejects(invalid.run("translate_text", { text: ["a"], target: "en" }, { source: "tool" }), (error) => error.kind === "auth_error");
  const disabled = createRunner([{ status: 403, body: { error: { code: 403, message: "Cloud Translation API has not been used in project 1 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } } }]);
  await assert.rejects(disabled.run("translate_text", { text: ["a"], target: "en" }, { source: "tool" }), (error) => error.kind === "permission_denied" && /has not been used/.test(error.message));
});

test("more than 128 texts are refused before any request", async () => {
  const { run, calls } = createRunner([]);
  await assert.rejects(run("translate_text", { text: Array.from({ length: 129 }, () => "a"), target: "en" }, { source: "tool" }), (error) => error.kind === "invalid_input");
  assert.equal(calls.length, 0);
});

test("translate_text and detect_language are never retried after a 5xx (characters may have been billed)", async () => {
  for (const [operationName, args] of [["translate_text", { text: ["a"], target: "en" }], ["detect_language", { text: ["a"] }]]) {
    const { run, calls } = createRunner([{ status: 500, headers: { "retry-after": "0" }, body: { error: { code: 500, message: "Internal" } } }, { body: {} }]);
    await assert.rejects(run(operationName, args, { source: "tool" }), (error) => error.retryable === false && /outcome unknown/.test(error.message) && /billed/.test(error.message), operationName);
    assert.equal(calls.length, 1, operationName);
  }
});
