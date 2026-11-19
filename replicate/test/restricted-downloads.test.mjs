import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { isAllowedDownloadUrl } from "../lib/restricted-downloads.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.replicate.com/v1";
const created = { id: "p1", status: "starting", urls: { get: `${API}/predictions/p1` } };

function createRunner(responses, extraEnvironment = {}) {
  const outputDirectory = mkdtempSync(join(tmpdir(), "replicate-hosts-"));
  const recordingFetch = createRecordingFetch(responses);
  const environment = { REPLICATE_API_TOKEN: "r8_test_not_real", REPLICATE_OUTPUT_DIR: outputDirectory, GRAPHRT_POLL_INTERVAL_MS: "0", ...extraEnvironment };
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch, resolveHostAddresses: async () => ["93.184.216.34"] });
  return { run, calls: recordingFetch.calls, cleanUp: () => rmSync(outputDirectory, { recursive: true, force: true }) };
}

test("isAllowedDownloadUrl accepts replicate.delivery and its subdomains only", () => {
  const allowed = { hostSuffixes: ["replicate.delivery"], extraHosts: [] };
  assert.equal(isAllowedDownloadUrl("https://replicate.delivery/a.png", allowed), true);
  assert.equal(isAllowedDownloadUrl("https://pbxt.replicate.delivery/x/out.png", allowed), true);
  assert.equal(isAllowedDownloadUrl("https://evilreplicate.delivery/a.png", allowed), false);
  assert.equal(isAllowedDownloadUrl("https://replicate.delivery.evil.example/a.png", allowed), false);
  assert.equal(isAllowedDownloadUrl("http://replicate.delivery/a.png", allowed), false);
  assert.equal(isAllowedDownloadUrl("https://cdn.example.com/a.png", { ...allowed, extraHosts: ["cdn.example.com"] }), true);
});

test("token-array outputs (language models) are not treated as files", async () => {
  const { run, calls, cleanUp } = createRunner([{ status: 201, body: created }, { body: { id: "p1", status: "succeeded", output: ["Hello", " world", "!"] } }]);
  try {
    const { data } = await run("run_model", { model_owner: "meta", model_name: "llama", input: { prompt: "hi" } }, { source: "tool" });
    assert.deepEqual(data.result, ["Hello", " world", "!"]);
    assert.deepEqual(data.saved_files, []);
    assert.equal(calls.length, 2, "no download attempts");
  } finally {
    cleanUp();
  }
});

test("output URLs outside replicate.delivery are reported, not downloaded", async () => {
  const { run, calls, cleanUp } = createRunner([
    { status: 201, body: created },
    { body: { id: "p1", status: "succeeded", output: ["https://replicate.delivery/ok.png", "https://attacker.example/x.png"] } },
    { body: "OK", headers: { "content-type": "image/png" } },
  ]);
  try {
    const { data } = await run("run_model", { model_owner: "o", model_name: "m", input: {} }, { source: "node" });
    assert.equal(calls.length, 3);
    assert.ok(data.saved_files.some((savedFile) => savedFile.url === "https://replicate.delivery/ok.png" && savedFile.path));
    assert.ok(data.saved_files.some((savedFile) => savedFile.url === "https://attacker.example/x.png" && /not downloaded/.test(savedFile.error)));
  } finally {
    cleanUp();
  }
});

test("REPLICATE_EXTRA_DOWNLOAD_HOSTS allows more hosts", async () => {
  const { run, cleanUp } = createRunner(
    [{ status: 201, body: created }, { body: { id: "p1", status: "succeeded", output: "https://files.mycdn.example/a.mp4" } }, { body: "MP4", headers: { "content-type": "video/mp4" } }],
    { REPLICATE_EXTRA_DOWNLOAD_HOSTS: "files.mycdn.example" },
  );
  try {
    const { data } = await run("create_prediction", { version: "v", input: {} }, { source: "node" });
    assert.ok(data.saved_files[0].path);
  } finally {
    cleanUp();
  }
});

test("wait false still returns the created prediction at once", async () => {
  const { run, calls, cleanUp } = createRunner([{ status: 201, body: created }]);
  try {
    const { data } = await run("run_model", { model_owner: "o", model_name: "m", input: {}, wait: false }, { source: "tool" });
    assert.equal(data.job_id, "p1");
    assert.equal(calls.length, 1);
  } finally {
    cleanUp();
  }
});
