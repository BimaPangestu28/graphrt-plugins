import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";

const FAKE_KEY = "xi-test-key-0001";
const publicResolver = async () => ["93.184.216.34"];
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "retry-after": "0" } });

function createScriptedRunner(environment, respond) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init, calls.length - 1);
  };
  const run = createOperationRunner(pluginDefinition, { ELEVENLABS_API_KEY: FAKE_KEY, ELEVENLABS_OUTPUT_DIR: join(tmpdir(), "elevenlabs-unused-out"), ...environment }, { fetchImpl, resolveHostAddresses: publicResolver });
  return { run, calls };
}

const PAID_CALLS = {
  text_to_speech: { voice_id: "v1", text: "Hi" },
  generate_sound_effect: { text: "rain" },
  speech_to_text: { source_url: "https://media.example.com/a.mp3" },
};

test("paid calls are not retried after a 5xx and point to list_history", async () => {
  for (const [operationName, args] of Object.entries(PAID_CALLS)) {
    const { run, calls } = createScriptedRunner({}, () => jsonResponse({ detail: { message: "busy" } }, 503));
    await assert.rejects(run(operationName, args, { source: "tool" }), (error) => error.retryable === false && /outcome unknown/.test(error.message) && /list_history/.test(error.message), operationName);
    assert.equal(calls.length, 1, operationName);
  }
});

test("paid calls are not retried after a network failure or timeout", async () => {
  for (const [operationName, args] of Object.entries(PAID_CALLS)) {
    const { run, calls } = createScriptedRunner({}, () => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(run(operationName, args, { source: "tool" }), (error) => error.kind === "network_error" && error.retryable === false, operationName);
    assert.equal(calls.length, 1, operationName);
  }
});

test("speech_to_text needs exactly one of file or source_url, checked before any request", async () => {
  const { run, calls } = createScriptedRunner({}, () => jsonResponse({ text: "ok" }));
  await assert.rejects(run("speech_to_text", {}, { source: "tool" }), (error) => error.kind === "invalid_input" && /file.*source_url/.test(error.message));
  await assert.rejects(run("speech_to_text", { file: "https://media.example.com/a.mp3", source_url: "https://media.example.com/a.mp3" }, { source: "tool" }), (error) => error.kind === "invalid_input");
  assert.equal(calls.length, 0);
});

test("speech_to_text takes an https file: downloaded without the key, then uploaded as a multipart file", async () => {
  const { run, calls } = createScriptedRunner({}, (url, init, callIndex) => (callIndex === 0 ? new Response("ID3-REMOTE", { headers: { "content-type": "audio/mpeg" } }) : jsonResponse({ text: "halo" })));
  const result = await run("speech_to_text", { file: "https://media.example.com/talk.mp3" }, { source: "tool" });
  assert.equal(calls[0].init.headers?.["xi-api-key"], undefined);
  const uploadedFile = calls[1].init.body.get("file");
  assert.equal(uploadedFile.name, "talk.mp3");
  assert.equal(await uploadedFile.text(), "ID3-REMOTE");
  assert.equal(result.data.text, "halo");
});

test("speech_to_text refuses an https file over the 100 MB cap before uploading", async () => {
  const { run, calls } = createScriptedRunner({}, () => new Response("x", { headers: { "content-length": String(100 * 1024 * 1024 + 1) } }));
  await assert.rejects(run("speech_to_text", { file: "https://media.example.com/huge.mp3" }, { source: "tool" }), (error) => error.kind === "invalid_input");
  assert.equal(calls.length, 1);
});

test("speech_to_text redacts the key when ElevenLabs echoes it", async () => {
  const { run } = createScriptedRunner({}, () => jsonResponse({ text: `key ${FAKE_KEY}` }));
  const result = await run("speech_to_text", { source_url: "https://media.example.com/a.mp3" }, { source: "tool" });
  assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
});
