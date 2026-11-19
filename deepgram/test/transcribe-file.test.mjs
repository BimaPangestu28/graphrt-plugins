import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDescriptors, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const FAKE_KEY = "dg-test-key-0001";

function createRunner(environment, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const rawBodies = [];
  // createRecordingFetch keeps string bodies only; keep the raw bytes too.
  const fetchImpl = (url, init = {}) => {
    rawBodies.push(init.body);
    return recordingFetch(url, init);
  };
  const run = createOperationRunner(pluginDefinition, { DEEPGRAM_API_KEY: FAKE_KEY, ...environment }, { fetchImpl });
  return { run, calls: recordingFetch.calls, rawBodies };
}

function withUploadDirectory(callback) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "deepgram-upload-")));
  return Promise.resolve(callback(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

test("transcribe_file sends the raw file bytes with its media type and the listen query", () =>
  withUploadDirectory(async (uploadDirectory) => {
    const audioPath = join(uploadDirectory, "call.wav");
    writeFileSync(audioPath, "RIFF-WAVE-BYTES");
    const { run, calls, rawBodies } = createRunner({ DEEPGRAM_UPLOAD_DIR: uploadDirectory }, [{ body: { results: { channels: [] } } }]);
    const result = await run("transcribe_file", { file: audioPath, language: "id", diarize: true, keyterm: ["graphrt", "Bandung"] }, { source: "tool" });
    const sentUrl = new URL(calls[0].url);
    assert.equal(calls[0].method, "POST");
    assert.equal(`${sentUrl.origin}${sentUrl.pathname}`, "https://api.deepgram.com/v1/listen");
    assert.equal(sentUrl.searchParams.get("model"), "nova-3");
    assert.equal(sentUrl.searchParams.get("smart_format"), "true");
    assert.equal(sentUrl.searchParams.get("language"), "id");
    assert.equal(sentUrl.searchParams.get("diarize"), "true");
    assert.deepEqual(sentUrl.searchParams.getAll("keyterm"), ["graphrt", "Bandung"]);
    assert.equal(calls[0].headers.authorization, `Token ${FAKE_KEY}`);
    assert.equal(calls[0].headers["content-type"], "audio/wav");
    assert.equal(Buffer.from(rawBodies[0]).toString(), "RIFF-WAVE-BYTES");
    assert.deepEqual(result.data, { results: { channels: [] } });
  }));

test("transcribe_file refuses local files without DEEPGRAM_UPLOAD_DIR, outside it, or through a symlink", () =>
  withUploadDirectory(async (uploadDirectory) => {
    const linkPath = join(uploadDirectory, "escape.wav");
    symlinkSync("/etc/hosts", linkPath);
    const withoutDirectory = createRunner({}, []);
    await assert.rejects(withoutDirectory.run("transcribe_file", { file: "/etc/hosts" }, { source: "tool" }), (error) => error.kind === "invalid_input" && error.message.includes("DEEPGRAM_UPLOAD_DIR"));
    const withDirectory = createRunner({ DEEPGRAM_UPLOAD_DIR: uploadDirectory }, []);
    await assert.rejects(withDirectory.run("transcribe_file", { file: linkPath }, { source: "tool" }), (error) => error.kind === "invalid_input" && error.message.includes("outside"));
    await assert.rejects(withDirectory.run("transcribe_file", { file: "relative.wav" }, { source: "tool" }), (error) => error.kind === "invalid_input");
    assert.equal(withoutDirectory.calls.length + withDirectory.calls.length, 0);
  }));

test("transcribe_file requires file and validates query params before any request", async () => {
  const { run, calls } = createRunner({}, []);
  await assert.rejects(run("transcribe_file", {}, { source: "tool" }), (error) => error.kind === "invalid_input");
  await assert.rejects(run("transcribe_file", { file: "/x.wav", redact: ["everything"] }, { source: "tool" }), (error) => error.kind === "invalid_input");
  assert.equal(calls.length, 0);
});

test("transcribe_file maps INVALID_AUTH to auth_error and redacts the key", () =>
  withUploadDirectory(async (uploadDirectory) => {
    const audioPath = join(uploadDirectory, "a.mp3");
    writeFileSync(audioPath, "ID3");
    const { run } = createRunner({ DEEPGRAM_UPLOAD_DIR: uploadDirectory }, [{ status: 401, body: { err_code: "INVALID_AUTH", err_msg: `Invalid credentials ${FAKE_KEY}.` } }]);
    await assert.rejects(run("transcribe_file", { file: audioPath }, { source: "node" }), (error) => error.kind === "auth_error" && error.message.includes("INVALID_AUTH") && !error.message.includes(FAKE_KEY));
  }));

test("transcribe_file truncates large results for agent tools but not for nodes", () =>
  withUploadDirectory(async (uploadDirectory) => {
    const audioPath = join(uploadDirectory, "long.mp3");
    writeFileSync(audioPath, "ID3");
    const hugeBody = { results: { transcript: "x".repeat(150000) } };
    const toolRun = createRunner({ DEEPGRAM_UPLOAD_DIR: uploadDirectory }, [{ body: hugeBody }]);
    const toolResult = await toolRun.run("transcribe_file", { file: audioPath }, { source: "tool" });
    assert.equal(toolResult.data.truncated, true);
    const nodeRun = createRunner({ DEEPGRAM_UPLOAD_DIR: uploadDirectory }, [{ body: hugeBody }]);
    const nodeResult = await nodeRun.run("transcribe_file", { file: audioPath }, { source: "node" });
    assert.equal(nodeResult.data.results.transcript.length, 150000);
  }));

test("transcribe_file is a tool and DEEPGRAM_UPLOAD_DIR is a declared env var", () => {
  assert.ok(buildDescriptors(pluginDefinition).tools.some((tool) => tool.name === "transcribe_file"));
  assert.ok(pluginDefinition.extraEnv.includes("DEEPGRAM_UPLOAD_DIR"));
});
