import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDescriptors, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const FAKE_KEY = "aai-test-key-0001";

function createRunner(environment, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const rawBodies = [];
  // createRecordingFetch keeps string bodies only; keep the raw bytes too.
  const fetchImpl = (url, init = {}) => {
    rawBodies.push(init.body);
    return recordingFetch(url, init);
  };
  const run = createOperationRunner(pluginDefinition, { ASSEMBLYAI_API_KEY: FAKE_KEY, GRAPHRT_POLL_INTERVAL_MS: "0", ...environment }, { fetchImpl });
  return { run, calls: recordingFetch.calls, rawBodies };
}

function withUploadDirectory(callback) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "assemblyai-upload-")));
  return Promise.resolve(callback(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

test("upload_file posts the raw bytes as application/octet-stream with the bare key", () =>
  withUploadDirectory(async (uploadDirectory) => {
    const audioPath = join(uploadDirectory, "interview.mp3");
    writeFileSync(audioPath, "ID3-AUDIO");
    const uploadUrl = "https://cdn.assemblyai.com/upload/abc";
    const { run, calls, rawBodies } = createRunner({ ASSEMBLYAI_UPLOAD_DIR: uploadDirectory }, [{ body: { upload_url: uploadUrl } }]);
    const result = await run("upload_file", { file: audioPath }, { source: "tool" });
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "https://api.assemblyai.com/v2/upload");
    assert.equal(calls[0].headers.authorization, FAKE_KEY);
    assert.equal(calls[0].headers["content-type"], "application/octet-stream");
    assert.equal(Buffer.from(rawBodies[0]).toString(), "ID3-AUDIO");
    assert.deepEqual(result.data, { upload_url: uploadUrl });
  }));

test("upload_file refuses files outside ASSEMBLYAI_UPLOAD_DIR, symlinks out of it, and a missing allowlist", () =>
  withUploadDirectory(async (uploadDirectory) => {
    const linkPath = join(uploadDirectory, "escape.mp3");
    symlinkSync("/etc/hosts", linkPath);
    const allowed = createRunner({ ASSEMBLYAI_UPLOAD_DIR: uploadDirectory }, []);
    await assert.rejects(allowed.run("upload_file", { file: linkPath }, { source: "tool" }), (error) => error.kind === "invalid_input" && error.message.includes("outside"));
    await assert.rejects(allowed.run("upload_file", { file: "/etc/hosts" }, { source: "tool" }), (error) => error.kind === "invalid_input");
    const disabled = createRunner({}, []);
    await assert.rejects(disabled.run("upload_file", { file: "/etc/hosts" }, { source: "tool" }), (error) => error.kind === "invalid_input" && error.message.includes("ASSEMBLYAI_UPLOAD_DIR"));
    assert.equal(allowed.calls.length + disabled.calls.length, 0);
  }));

test("transcribe polls until completed and returns the transcript", async () => {
  const { run, calls } = createRunner({}, [
    { body: { id: "t-9", status: "queued" } },
    { body: { id: "t-9", status: "processing" } },
    { body: { id: "t-9", status: "completed", text: "halo" } },
  ]);
  const result = await run("transcribe", { audio_url: "https://example.com/a.mp3" }, { source: "tool" });
  assert.equal(calls[1].url, "https://api.assemblyai.com/v2/transcript/t-9");
  assert.equal(result.data.job_id, "t-9");
  assert.equal(result.data.status, "completed");
  assert.equal(result.data.result.text, "halo");
});

test("a transcript with status error fails with AssemblyAI's reason and is not retryable", async () => {
  const { run } = createRunner({}, [{ body: { id: "t-9", status: "queued" } }, { body: { id: "t-9", status: "error", error: "Download error, unable to download https://x" } }]);
  await assert.rejects(run("transcribe", { audio_url: "https://x" }, { source: "node" }), (error) => error.message.includes("t-9") && error.message.includes("Download error") && error.retryable === false);
});

test("ASSEMBLYAI_REGION=eu sends transcripts and LLM Gateway calls to the EU hosts", async () => {
  const { run, calls } = createRunner({ ASSEMBLYAI_REGION: "eu" }, [{ body: { id: "t-1" } }, { body: { choices: [] } }]);
  await run("get_transcript", { transcript_id: "t-1" }, { source: "tool" });
  await run("create_chat_completion", { model: "claude-x", prompt: "hi" }, { source: "tool" });
  assert.equal(calls[0].url, "https://api.eu.assemblyai.com/v2/transcript/t-1");
  assert.equal(calls[1].url, "https://llm-gateway.eu.assemblyai.com/v1/chat/completions");
});

test("an unknown ASSEMBLYAI_REGION is refused", async () => {
  const { run, calls } = createRunner({ ASSEMBLYAI_REGION: "ap" }, []);
  await assert.rejects(run("get_transcript", { transcript_id: "t-1" }, { source: "tool" }), (error) => error.kind === "invalid_input" && error.message.includes("ASSEMBLYAI_REGION"));
  assert.equal(calls.length, 0);
});

test("list_llm_models sends no credential", async () => {
  const { run, calls } = createRunner({}, [{ body: { data: [] } }]);
  await run("list_llm_models", {}, { source: "tool" });
  assert.equal(calls[0].headers.authorization, undefined);
});

test("an invalid key maps to auth_error with the API's message", async () => {
  const { run } = createRunner({}, [{ status: 401, body: { error: "Authentication error, API token missing/invalid" } }]);
  await assert.rejects(run("list_transcripts", {}, { source: "node" }), (error) => error.kind === "auth_error" && error.message.includes("API token missing/invalid"));
});

test("list_transcripts follows prev_url (older transcripts) as the cursor", async () => {
  const olderPage = "https://api.assemblyai.com/v2/transcript?limit=10&before_id=t-5";
  const { run, calls } = createRunner({}, [{ body: { page_details: { prev_url: olderPage }, transcripts: [{ id: "t-6" }] } }, { body: { page_details: { prev_url: null }, transcripts: [{ id: "t-5" }] } }]);
  const firstPage = await run("list_transcripts", {}, { source: "tool" });
  assert.equal(firstPage.next_cursor, olderPage);
  const secondPage = await run("list_transcripts", { cursor: firstPage.next_cursor }, { source: "tool" });
  assert.equal(calls[1].url, olderPage);
  assert.equal(secondPage.next_cursor, null);
});

test("delete_transcript is node only; upload and transcribe are tools", () => {
  const toolNames = buildDescriptors(pluginDefinition).tools.map((tool) => tool.name);
  assert.equal(toolNames.includes("delete_transcript"), false);
  assert.ok(toolNames.includes("upload_file") && toolNames.includes("transcribe"));
});
