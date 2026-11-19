import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.stability.ai";
const SAMPLE_URL = "https://files.contract.example/loop.wav";
// "ID3" + bytes: sniffed as audio/mpeg when saved.
const MP3_BASE64 = Buffer.from("ID3-fake-mp3").toString("base64");

describeRestPluginContract(pluginDefinition, {
  operations: {
    text_to_audio: {
      args: { prompt: "Gamelan with ambient synth pads", duration: 20, seed: 42 },
      request: {
        method: "POST",
        url: `${API}/v2beta/audio/stable-audio-2/text-to-audio`,
        query: "absent",
        multipart: { prompt: "Gamelan with ambient synth pads", duration: "20", seed: "42", model: "stable-audio-2.5" },
        headers: { accept: "audio/*" },
      },
    },
    audio_to_audio: {
      args: { prompt: "Turn into jazz", audio: SAMPLE_URL, strength: 0.6 },
      request: {
        method: "POST",
        url: `${API}/v2beta/audio/stable-audio-2/audio-to-audio`,
        query: "absent",
        multipart: { prompt: "Turn into jazz", audio: "loop.wav", strength: "0.6", model: "stable-audio-2.5" },
        headers: { accept: "audio/*" },
      },
    },
    inpaint_audio: {
      args: { prompt: "Drum fill", audio: SAMPLE_URL, mask_start: 10, mask_end: 14 },
      request: {
        method: "POST",
        url: `${API}/v2beta/audio/stable-audio-2/inpaint`,
        query: "absent",
        multipart: { prompt: "Drum fill", audio: "loop.wav", mask_start: "10", mask_end: "14" },
        headers: { accept: "audio/*" },
      },
    },
    text_to_audio_v3: {
      args: { prompt: "Cinematic orchestral piece", duration: 300 },
      request: {
        method: "POST",
        url: `${API}/v2beta/audio/stable-audio/text-to-audio`,
        query: "absent",
        multipart: { prompt: "Cinematic orchestral piece", duration: "300", model: "stable-audio-3" },
      },
    },
    get_audio_result: {
      args: { generation_id: "gen-1" },
      request: { method: "GET", url: `${API}/v2beta/audio/results/gen-1`, query: "absent" },
      response: { body: { id: "gen-1", status: "in-progress" } },
      expect: { data: { result: { id: "gen-1", status: "in-progress" }, saved_files: [] } },
    },
    get_balance: {
      args: {},
      request: { method: "GET", url: `${API}/v1/user/balance`, query: "absent" },
      response: { body: { credits: 12.5 } },
      expect: { data: { credits: 12.5 } },
    },
    get_account: {
      args: {},
      request: { method: "GET", url: `${API}/v1/user/account`, query: "absent" },
    },
  },
});

function withOutputDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), "stable-audio-out-"));
  return Promise.resolve(callback(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

function createRunner(environment, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { STABILITY_API_KEY: "sk-test-0001", GRAPHRT_POLL_INTERVAL_MS: "0", ...environment }, { fetchImpl: recordingFetch });
  return { run, calls: recordingFetch.calls };
}

test("text_to_audio_v3 polls until done and saves the base64 audio from the finished poll body (no second fetch)", () =>
  withOutputDirectory(async (outputDirectory) => {
    const { run, calls } = createRunner({ STABLE_AUDIO_OUTPUT_DIR: outputDirectory }, [
      { status: 202, body: { id: "gen-7" } },
      { status: 202, body: { id: "gen-7", status: "in-progress" } },
      { body: { audio: MP3_BASE64, seed: 99, finish_reason: "SUCCESS" } },
    ]);
    const result = await run("text_to_audio_v3", { prompt: "Kroncong ballad" }, { source: "tool" });
    assert.equal(calls[1].url, "https://api.stability.ai/v2beta/audio/results/gen-7");
    assert.equal(calls[1].headers.accept, "application/json");
    assert.equal(calls.length, 3, "create, one pending poll, the finished poll: the audio is not fetched twice");
    assert.equal(result.data.job_id, "gen-7");
    assert.equal(result.data.result.seed, 99);
    assert.match(result.data.result.audio, /^\[saved to /);
    const savedFile = result.data.saved_files[0];
    assert.equal(savedFile.content_type, "audio/mpeg");
    assert.ok(savedFile.path.startsWith(outputDirectory));
    assert.equal(readFileSync(savedFile.path, "utf8"), "ID3-fake-mp3");
  }));

test("text_to_audio writes the binary audio into STABLE_AUDIO_OUTPUT_DIR", () =>
  withOutputDirectory(async (outputDirectory) => {
    const { run, calls } = createRunner({ STABLE_AUDIO_OUTPUT_DIR: outputDirectory }, [{ body: "RIFF-wav", headers: { "content-type": "audio/wav", "finish-reason": "SUCCESS" } }]);
    const result = await run("text_to_audio", { prompt: "Rain on a tin roof", output_format: "wav" }, { source: "tool" });
    assert.equal(calls[0].headers.authorization, "Bearer sk-test-0001");
    assert.equal(result.data.content_type, "audio/wav");
    assert.equal(readFileSync(result.data.path, "utf8"), "RIFF-wav");
  }));

test("generation without STABLE_AUDIO_OUTPUT_DIR is refused before any request (nothing is paid for)", async () => {
  const { run, calls } = createRunner({}, []);
  await assert.rejects(run("text_to_audio", { prompt: "x" }, { source: "tool" }), (error) => error.kind === "invalid_input" && error.message.includes("STABLE_AUDIO_OUTPUT_DIR"));
  assert.equal(calls.length, 0);
});

test("Stability's {name, errors} body becomes the error message and kind", async () => {
  const { run } = createRunner({}, [{ status: 401, body: { id: "e1", name: "unauthorized", errors: ["Authorization failed: invalid API key"] } }]);
  await assert.rejects(run("get_balance", {}, { source: "node" }), (error) => error.kind === "auth_error" && error.message.includes("Authorization failed: invalid API key (unauthorized)"));
});

test("content moderation is a non-retryable permission_denied", async () => {
  const { run } = createRunner({ STABLE_AUDIO_OUTPUT_DIR: join(tmpdir(), "stable-audio-unused") }, [{ status: 403, body: { id: "e2", name: "content_moderation", errors: ["Your request was flagged by our content moderation system"] } }]);
  await assert.rejects(run("text_to_audio", { prompt: "x" }, { source: "node" }), (error) => error.kind === "permission_denied" && error.message.includes("content moderation"));
});
