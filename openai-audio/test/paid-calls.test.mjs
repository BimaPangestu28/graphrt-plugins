import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";

const FAKE_KEY = "sk-test-0001";
const publicResolver = async () => ["93.184.216.34"];
const AUDIO_URL = "https://media.example.com/talk.mp3";
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "retry-after": "0" } });
const audioResponse = () => new Response("ID3-REMOTE", { headers: { "content-type": "audio/mpeg" } });

function createScriptedRunner(respond) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init, calls.length - 1);
  };
  const environment = { OPENAI_API_KEY: FAKE_KEY, OPENAI_AUDIO_OUTPUT_DIR: join(tmpdir(), "openai-audio-unused-out") };
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl, resolveHostAddresses: publicResolver });
  return { run, calls };
}

// The file download (when there is one) answers first; the OpenAI call fails.
const failingApi = (failure) => (url) => (url.startsWith("https://media.example.com/") ? audioResponse() : failure());
const PAID_CALLS = {
  create_speech: { input: "Hi" },
  create_transcription: { file: AUDIO_URL },
  create_translation: { file: AUDIO_URL },
};
const apiCalls = (calls) => calls.filter((call) => call.url.startsWith("https://api.openai.com/"));

test("paid calls are not retried after a 5xx and say the outcome is unknown", async () => {
  for (const [operationName, args] of Object.entries(PAID_CALLS)) {
    const { run, calls } = createScriptedRunner(failingApi(() => jsonResponse({ error: { message: "busy" } }, 503)));
    await assert.rejects(run(operationName, args, { source: "tool" }), (error) => error.retryable === false && /outcome unknown/.test(error.message) && /usage/.test(error.message), operationName);
    assert.equal(apiCalls(calls).length, 1, operationName);
  }
});

test("paid calls are not retried after a network failure or timeout", async () => {
  for (const [operationName, args] of Object.entries(PAID_CALLS)) {
    const { run, calls } = createScriptedRunner(
      failingApi(() => {
        throw new TypeError("fetch failed");
      }),
    );
    await assert.rejects(run(operationName, args, { source: "tool" }), (error) => error.kind === "network_error" && error.retryable === false, operationName);
    assert.equal(apiCalls(calls).length, 1, operationName);
  }
});

test("an https audio input is downloaded without the key and uploaded as the multipart file", async () => {
  const { run, calls } = createScriptedRunner((url) => (url === AUDIO_URL ? audioResponse() : jsonResponse({ text: "halo" })));
  const result = await run("create_transcription", { file: AUDIO_URL }, { source: "tool" });
  assert.equal(calls[0].init.headers?.authorization, undefined);
  const uploadedFile = calls[1].init.body.get("file");
  assert.equal(uploadedFile.name, "talk.mp3");
  assert.equal(await uploadedFile.text(), "ID3-REMOTE");
  assert.deepEqual(result.data, { text: "halo" });
});

test("an https audio input over OpenAI's 25 MB limit is refused before calling OpenAI", async () => {
  const { run, calls } = createScriptedRunner(() => new Response("x", { headers: { "content-length": String(25 * 1024 * 1024 + 1) } }));
  await assert.rejects(run("create_transcription", { file: AUDIO_URL }, { source: "tool" }), (error) => error.kind === "invalid_input");
  assert.equal(apiCalls(calls).length, 0);
});

test("the key is redacted when OpenAI echoes it in a transcription", async () => {
  const { run } = createScriptedRunner((url) => (url === AUDIO_URL ? audioResponse() : jsonResponse({ text: `said ${FAKE_KEY}` })));
  const result = await run("create_transcription", { file: AUDIO_URL }, { source: "tool" });
  assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
});
