import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.openai.com/v1";
const SAMPLE_URL = "https://files.contract.example/meeting.m4a";

describeRestPluginContract(pluginDefinition, {
  operations: {
    create_speech: {
      args: { input: "Selamat pagi", voice: "coral", instructions: "Speak warmly", response_format: "wav", speed: 1.25 },
      request: {
        method: "POST",
        url: `${API}/audio/speech`,
        query: "absent",
        json: { input: "Selamat pagi", model: "gpt-4o-mini-tts", voice: "coral", instructions: "Speak warmly", response_format: "wav", speed: 1.25 },
        headers: { accept: "application/octet-stream" },
      },
    },
    create_transcription: {
      args: { file: SAMPLE_URL, language: "id", model: "whisper-1", response_format: "verbose_json", timestamp_granularities: ["word"] },
      request: {
        method: "POST",
        url: `${API}/audio/transcriptions`,
        query: "absent",
        multipart: { file: "meeting.m4a", model: "whisper-1", language: "id", response_format: "verbose_json", "timestamp_granularities[]": "word" },
      },
      response: { body: { text: "halo semua", language: "indonesian" } },
      expect: { data: { text: "halo semua", language: "indonesian" } },
    },
    create_translation: {
      args: { file: SAMPLE_URL, response_format: "text" },
      request: { method: "POST", url: `${API}/audio/translations`, query: "absent", multipart: { file: "meeting.m4a", model: "whisper-1", response_format: "text" } },
    },
    list_models: {
      args: {},
      request: { method: "GET", url: `${API}/models`, query: "absent" },
      response: { body: { object: "list", data: [{ id: "whisper-1" }] } },
      expect: { data: [{ id: "whisper-1" }] },
    },
  },
});

function createRunner(environment, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { OPENAI_API_KEY: "sk-test-0001", ...environment }, { fetchImpl: recordingFetch });
  return { run, calls: recordingFetch.calls };
}

function withTemporaryDirectory(prefix, callback) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return Promise.resolve(callback(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

test("create_speech writes the audio into OPENAI_AUDIO_OUTPUT_DIR", () =>
  withTemporaryDirectory("openai-audio-out-", async (outputDirectory) => {
    const { run, calls } = createRunner({ OPENAI_AUDIO_OUTPUT_DIR: outputDirectory }, [{ body: "ID3-MP3", headers: { "content-type": "audio/mpeg" } }]);
    const result = await run("create_speech", { input: "Hi" }, { source: "tool" });
    assert.equal(calls[0].headers.authorization, "Bearer sk-test-0001");
    assert.equal(result.data.content_type, "audio/mpeg");
    assert.equal(readFileSync(result.data.path, "utf8"), "ID3-MP3");
  }));

test("create_transcription uploads a local file from OPENAI_AUDIO_UPLOAD_DIR with repeated array fields", () =>
  withTemporaryDirectory("openai-audio-in-", async (uploadDirectory) => {
    const audioPath = join(uploadDirectory, "call.mp3");
    writeFileSync(audioPath, "ID3-LOCAL");
    const { run, calls } = createRunner({ OPENAI_AUDIO_UPLOAD_DIR: uploadDirectory }, [{ body: { text: "ok" } }]);
    await run("create_transcription", { file: audioPath, model: "whisper-1", response_format: "verbose_json", timestamp_granularities: ["word", "segment"] }, { source: "tool" });
    const uploadedFile = calls[0].formData.get("file");
    assert.equal(uploadedFile.name, "call.mp3");
    assert.equal(await uploadedFile.text(), "ID3-LOCAL");
    assert.deepEqual(calls[0].formData.getAll("timestamp_granularities[]"), ["word", "segment"]);
  }));

test("local files outside OPENAI_AUDIO_UPLOAD_DIR (also through symlinks) are refused", () =>
  withTemporaryDirectory("openai-audio-in-", async (uploadDirectory) => {
    const linkPath = join(uploadDirectory, "escape.mp3");
    symlinkSync("/etc/hosts", linkPath);
    const { run, calls } = createRunner({ OPENAI_AUDIO_UPLOAD_DIR: uploadDirectory }, []);
    await assert.rejects(run("create_transcription", { file: linkPath }, { source: "tool" }), (error) => error.kind === "invalid_input" && error.message.includes("outside"));
    await assert.rejects(run("create_transcription", { file: "/etc/hosts" }, { source: "tool" }), (error) => error.kind === "invalid_input");
    assert.equal(calls.length, 0);
  }));

test("text response formats (srt, vtt, text) come back as {text: <the raw body>}", () =>
  withTemporaryDirectory("openai-audio-in-", async (uploadDirectory) => {
    const audioPath = join(uploadDirectory, "talk.wav");
    writeFileSync(audioPath, "RIFF-LOCAL");
    const subtitles = "1\n00:00:00,000 --> 00:00:01,000\nhello\n";
    const { run } = createRunner({ OPENAI_AUDIO_UPLOAD_DIR: uploadDirectory }, [{ body: subtitles, headers: { "content-type": "text/plain" } }]);
    const result = await run("create_translation", { file: audioPath, response_format: "srt" }, { source: "node" });
    assert.deepEqual(result.data, { text: subtitles });
  }));

test("an invalid key maps to auth_error with OpenAI's message", async () => {
  const { run } = createRunner({}, [{ status: 401, body: { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } } }]);
  await assert.rejects(run("list_models", {}, { source: "node" }), (error) => error.kind === "auth_error" && error.message.includes("Incorrect API key provided (invalid_api_key)"));
});
