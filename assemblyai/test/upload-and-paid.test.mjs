import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";

const FAKE_KEY = "aai-test-key-0001";
const publicResolver = async () => ["93.184.216.34"];
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "retry-after": "0" } });

function createScriptedRunner(environment, respond) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init, calls.length - 1);
  };
  const run = createOperationRunner(pluginDefinition, { ASSEMBLYAI_API_KEY: FAKE_KEY, ...environment }, { fetchImpl, resolveHostAddresses: publicResolver });
  return { run, calls };
}

test("upload_file downloads an https file without the key, then uploads it as application/octet-stream", async () => {
  const { run, calls } = createScriptedRunner({}, (url, init, callIndex) => (callIndex === 0 ? new Response("ID3-REMOTE", { headers: { "content-type": "audio/mpeg" } }) : jsonResponse({ upload_url: "https://cdn.assemblyai.com/upload/x" })));
  const result = await run("upload_file", { file: "https://media.example.com/talk.mp3" }, { source: "tool" });
  assert.equal(calls[0].init.headers?.authorization, undefined);
  assert.equal(calls[1].url, "https://api.assemblyai.com/v2/upload");
  assert.equal(calls[1].init.headers["content-type"], "application/octet-stream");
  assert.equal(Buffer.from(calls[1].init.body).toString(), "ID3-REMOTE");
  assert.deepEqual(result.data, { upload_url: "https://cdn.assemblyai.com/upload/x" });
});

test("upload_file refuses an https file over the 200 MB cap before uploading", async () => {
  const { run, calls } = createScriptedRunner({}, () => new Response("x", { headers: { "content-length": String(200 * 1024 * 1024 + 1) } }));
  await assert.rejects(run("upload_file", { file: "https://media.example.com/huge.mp3" }, { source: "tool" }), (error) => error.kind === "invalid_input");
  assert.equal(calls.length, 1, "only the download was attempted");
});

test("upload_file is free and harmless to repeat, so a 5xx is retried", async () => {
  const { run, calls } = createScriptedRunner({}, (url, init, callIndex) => {
    if (callIndex === 0) return new Response("ID3", { headers: { "content-type": "audio/mpeg" } });
    return callIndex === 1 ? jsonResponse({ error: "busy" }, 503) : jsonResponse({ upload_url: "https://cdn.assemblyai.com/upload/y" });
  });
  const result = await run("upload_file", { file: "https://media.example.com/a.mp3" }, { source: "node" });
  assert.equal(calls.length, 3, "one download, two upload attempts");
  assert.equal(result.data.upload_url, "https://cdn.assemblyai.com/upload/y");
});

test("create_chat_completion is paid: not retried after a 5xx or a network failure", async () => {
  const failures = [() => jsonResponse({ message: "busy" }, 503), () => {
    throw new TypeError("fetch failed");
  }];
  for (const respond of failures) {
    const { run, calls } = createScriptedRunner({}, respond);
    await assert.rejects(run("create_chat_completion", { model: "m", prompt: "hi" }, { source: "tool" }), (error) => error.retryable === false && /outcome unknown/.test(error.message));
    assert.equal(calls.length, 1);
  }
});
