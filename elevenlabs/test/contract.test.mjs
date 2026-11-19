import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDescriptors, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.elevenlabs.io";
const SAMPLE_URL = "https://files.contract.example/sample.mp3";

describeRestPluginContract(pluginDefinition, {
  operations: {
    text_to_speech: {
      args: { voice_id: "JBFqnCBsd6RMkjVDRZzb", text: "Halo dunia", model_id: "eleven_flash_v2_5", voice_settings: { stability: 0.4 }, output_format: "mp3_44100_64" },
      request: {
        method: "POST",
        url: `${API}/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb`,
        query: { output_format: "mp3_44100_64" },
        json: { text: "Halo dunia", model_id: "eleven_flash_v2_5", voice_settings: { stability: 0.4 } },
      },
    },
    generate_sound_effect: {
      args: { text: "glass shattering", duration_seconds: 2.5, loop: true },
      request: { method: "POST", url: `${API}/v1/sound-generation`, query: "absent", json: { text: "glass shattering", duration_seconds: 2.5, loop: true } },
    },
    speech_to_text: {
      args: { file: SAMPLE_URL, diarize: true, keyterms: ["graphrt"], enable_logging: false },
      request: {
        method: "POST",
        url: `${API}/v1/speech-to-text`,
        query: { enable_logging: "false" },
        multipart: { model_id: "scribe_v2", file: "sample.mp3", diarize: "true", keyterms: "graphrt" },
      },
      response: { body: { language_code: "ind", text: "halo" } },
      expect: { data: { language_code: "ind", text: "halo" } },
    },
    list_voices: {
      args: { search: "rachel", category: "premade", limit: 20 },
      request: { method: "GET", url: `${API}/v2/voices`, query: { search: "rachel", category: "premade", page_size: "20" } },
      response: { body: { voices: [{ voice_id: "v1" }], has_more: false, next_page_token: null } },
      expect: { data: [{ voice_id: "v1" }] },
    },
    get_voice: {
      args: { voice_id: "v1" },
      request: { method: "GET", url: `${API}/v1/voices/v1`, query: "absent" },
    },
    list_models: {
      args: {},
      request: { method: "GET", url: `${API}/v1/models`, query: "absent" },
      response: { body: [{ model_id: "eleven_v3" }] },
      expect: { data: [{ model_id: "eleven_v3" }] },
    },
    list_history: {
      args: { voice_id: "v1", source: "TTS", limit: 50 },
      request: { method: "GET", url: `${API}/v1/history`, query: { voice_id: "v1", source: "TTS", page_size: "50" } },
      response: { body: { history: [{ history_item_id: "h1" }], has_more: false, last_history_item_id: "h1" } },
      expect: { data: [{ history_item_id: "h1" }] },
    },
    get_history_audio: {
      args: { history_item_id: "h1" },
      request: { method: "GET", url: `${API}/v1/history/h1/audio`, query: "absent" },
    },
    get_subscription: {
      args: {},
      request: { method: "GET", url: `${API}/v1/user/subscription`, query: "absent" },
    },
    clone_voice: {
      args: { name: "Narrator", sample: SAMPLE_URL, labels: '{"accent":"javanese"}' },
      request: { method: "POST", url: `${API}/v1/voices/add`, query: "absent", multipart: { name: "Narrator", files: "sample.mp3", labels: '{"accent":"javanese"}' } },
    },
    delete_voice: {
      args: { voice_id: "v1" },
      request: { method: "DELETE", url: `${API}/v1/voices/v1`, query: "absent", body: "absent" },
    },
  },
});

function createRunner(environment, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { ELEVENLABS_API_KEY: "xi-test-key", ...environment }, { fetchImpl: recordingFetch });
  return { run, calls: recordingFetch.calls };
}

test("text_to_speech streams the audio into ELEVENLABS_OUTPUT_DIR and returns the path", async () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "elevenlabs-out-"));
  try {
    const { run, calls } = createRunner({ ELEVENLABS_OUTPUT_DIR: outputDirectory }, [{ body: "ID3-AUDIO", headers: { "content-type": "audio/mpeg" } }]);
    const result = await run("text_to_speech", { voice_id: "v1", text: "Hi" }, { source: "tool" });
    assert.equal(calls[0].headers["xi-api-key"], "xi-test-key");
    assert.ok(result.data.path.startsWith(outputDirectory));
    assert.equal(readFileSync(result.data.path, "utf8"), "ID3-AUDIO");
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("text_to_speech without ELEVENLABS_OUTPUT_DIR is refused before any request", async () => {
  const { run, calls } = createRunner({}, []);
  await assert.rejects(run("text_to_speech", { voice_id: "v1", text: "Hi" }, { source: "node" }), (error) => error.kind === "invalid_input" && error.message.includes("ELEVENLABS_OUTPUT_DIR"));
  assert.equal(calls.length, 0);
});

test("an invalid key maps to auth_error with the API's message and code", async () => {
  const { run } = createRunner({}, [{ status: 401, body: { detail: { type: "authentication_error", code: "invalid_api_key", message: "Invalid API key" } } }]);
  await assert.rejects(run("get_subscription", {}, { source: "node" }), (error) => error.kind === "auth_error" && error.message.includes("Invalid API key (invalid_api_key)"));
});

test("a 422 validation error shows the first message", async () => {
  const { run } = createRunner({}, [{ status: 422, body: { detail: [{ loc: ["body", "text"], msg: "field required", type: "missing" }] } }]);
  await assert.rejects(run("list_models", {}, { source: "node" }), (error) => error.message.includes("field required"));
});

test("speech_to_text refuses local paths unless ELEVENLABS_UPLOAD_DIR allows them", async () => {
  const { run, calls } = createRunner({}, []);
  await assert.rejects(run("speech_to_text", { file: "/etc/passwd" }, { source: "tool" }), (error) => error.kind === "invalid_input" && error.message.includes("ELEVENLABS_UPLOAD_DIR"));
  assert.equal(calls.length, 0);
});

test("voice cloning and deletes are not offered to agents", () => {
  const toolNames = buildDescriptors(pluginDefinition).tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("text_to_speech"));
  assert.equal(toolNames.includes("clone_voice"), false);
  assert.equal(toolNames.includes("delete_voice"), false);
});

test("speech_to_text sends each keyterm as a repeated multipart field", async () => {
  const { run, calls } = createRunner({}, [{ body: { text: "ok" } }]);
  await run("speech_to_text", { source_url: "https://example.com/a.mp3", keyterms: ["graphrt", "Bandung"] }, { source: "node" });
  assert.deepEqual(calls[0].formData.getAll("keyterms"), ["graphrt", "Bandung"]);
  assert.equal(calls[0].formData.get("source_url"), "https://example.com/a.mp3");
  assert.equal(calls[0].formData.has("file"), false);
});
