import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";

const FAKE_KEY = "dg-test-key-0001";
const publicResolver = async () => ["93.184.216.34"];

function createScriptedRunner(environment, respond) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init, calls.length - 1);
  };
  const run = createOperationRunner(pluginDefinition, { DEEPGRAM_API_KEY: FAKE_KEY, ...environment }, { fetchImpl, resolveHostAddresses: publicResolver });
  return { run, calls };
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "retry-after": "0" } });

function withAudioFile(callback) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "deepgram-paid-")));
  const audioPath = join(directory, "a.wav");
  writeFileSync(audioPath, "RIFF");
  return Promise.resolve(callback({ directory, audioPath })).finally(() => rmSync(directory, { recursive: true, force: true }));
}

test("transcribe_file downloads an https file without the key, then uploads its bytes", async () => {
  const { run, calls } = createScriptedRunner({}, (url, init, callIndex) => (callIndex === 0 ? new Response("ID3-REMOTE", { headers: { "content-type": "audio/mpeg" } }) : jsonResponse({ results: {} })));
  await run("transcribe_file", { file: "https://media.example.com/talk.mp3" }, { source: "tool" });
  assert.equal(calls[0].url, "https://media.example.com/talk.mp3");
  assert.equal(calls[0].init.headers?.authorization, undefined);
  assert.equal(calls[1].init.headers["content-type"], "audio/mpeg");
  assert.equal(Buffer.from(calls[1].init.body).toString(), "ID3-REMOTE");
});

test("transcribe_file refuses an https file over the 200 MB cap before uploading", async () => {
  const oversized = () => new Response("x", { headers: { "content-type": "audio/mpeg", "content-length": String(200 * 1024 * 1024 + 1) } });
  const { run, calls } = createScriptedRunner({}, oversized);
  await assert.rejects(run("transcribe_file", { file: "https://media.example.com/huge.mp3" }, { source: "tool" }), (error) => error.kind === "invalid_input");
  assert.equal(calls.length, 1, "only the download was attempted");
});

test("transcribe_file is paid: a 5xx is not retried and the error says how to check", () =>
  withAudioFile(async ({ directory, audioPath }) => {
    const { run, calls } = createScriptedRunner({ DEEPGRAM_UPLOAD_DIR: directory }, () => jsonResponse({ err_msg: "busy" }, 503));
    await assert.rejects(run("transcribe_file", { file: audioPath }, { source: "tool" }), (error) => error.retryable === false && /outcome unknown/.test(error.message) && /list_project_requests/.test(error.message));
    assert.equal(calls.length, 1);
  }));

test("transcribe_file is not retried after a network failure or timeout", () =>
  withAudioFile(async ({ directory, audioPath }) => {
    const { run, calls } = createScriptedRunner({ DEEPGRAM_UPLOAD_DIR: directory }, () => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(run("transcribe_file", { file: audioPath }, { source: "tool" }), (error) => error.kind === "network_error" && error.retryable === false);
    assert.equal(calls.length, 1);
  }));

test("transcribe_file redacts the key when Deepgram echoes it in a response", () =>
  withAudioFile(async ({ directory, audioPath }) => {
    const { run } = createScriptedRunner({ DEEPGRAM_UPLOAD_DIR: directory }, () => jsonResponse({ metadata: { echoed: `Token ${FAKE_KEY}` } }));
    const result = await run("transcribe_file", { file: audioPath }, { source: "tool" });
    assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
  }));

test("paid operations (transcribe_url, text_to_speech, analyze_text) are not retried after a 5xx", async () => {
  const argsByOperation = { transcribe_url: { url: "https://x.example/a.wav" }, analyze_text: { text: "hi" }, text_to_speech: { text: "hi" } };
  for (const [operationName, args] of Object.entries(argsByOperation)) {
    const { run, calls } = createScriptedRunner({ DEEPGRAM_OUTPUT_DIR: join(tmpdir(), "deepgram-unused-out") }, () => jsonResponse({ err_msg: "busy" }, 503));
    await assert.rejects(run(operationName, args, { source: "tool" }), (error) => error.retryable === false && /list_project_requests/.test(error.message), operationName);
    assert.equal(calls.length, 1, operationName);
  }
});

test("analyze_text needs exactly one of text or url, checked before any request", async () => {
  const { run, calls } = createScriptedRunner({}, () => jsonResponse({}));
  await assert.rejects(run("analyze_text", {}, { source: "tool" }), (error) => error.kind === "invalid_input" && /text.*url/.test(error.message));
  await assert.rejects(run("analyze_text", { text: "a", url: "https://x.example/a.txt" }, { source: "tool" }), (error) => error.kind === "invalid_input");
  assert.equal(calls.length, 0);
  await run("analyze_text", { url: "https://x.example/a.txt" }, { source: "tool" });
  assert.equal(calls.length, 1);
});
