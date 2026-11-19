import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineRestPlugin } from "../lib/rest-plugin.mjs";
import { buildSpec, createScriptedFetch, runOperation, TEST_KEY } from "./fixtures/rest-test-helpers.mjs";

// --- bodyMode "file": the file is the whole request body --------------------------------------------------

async function withUploadDirectory(runWithDirectory) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rest-file-body-")));
  const allowedDirectory = join(root, "allowed");
  await mkdir(allowedDirectory);
  await writeFile(join(allowedDirectory, "voice.wav"), "RIFF-WAVE");
  await writeFile(join(root, "outside.txt"), "SECRET");
  try {
    return await runWithDirectory({ root, allowedDirectory });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const uploadOperation = (overrides = {}) => ({
  name: "listen",
  title: "Listen",
  description: "Transcribe a file",
  method: "POST",
  path: "/listen",
  write: "unsafe",
  checkHint: "list recent requests",
  bodyMode: "file",
  fileBody: { fileDirEnv: "PROBE_UPLOAD_DIR", maxFileBytes: 1024 },
  timeoutMs: 20000,
  params: {
    file: { in: "body", type: "string", file: true, required: true, description: "Audio" },
    model: { in: "query", type: "string", default: "nova-3" },
    trace: { in: "header", type: "string", wireName: "X-Trace" },
  },
  ...overrides,
});
const uploadSpec = (overrides, specOverrides) => buildSpec([uploadOperation(overrides)], { limits: { timeout_ms: 60000 }, ...specOverrides });

test("bodyMode file sends the local file's bytes as the body with its media type and the query params", async () => {
  await withUploadDirectory(async ({ allowedDirectory }) => {
    const fetchImpl = createScriptedFetch(() => ({ body: { ok: true } }));
    const { output, error } = await runOperation(uploadSpec(), "listen", { file: join(allowedDirectory, "voice.wav") }, { fetchImpl, environment: { PROBE_UPLOAD_DIR: allowedDirectory } });
    if (error) throw error;
    const [call] = fetchImpl.calls;
    assert.equal(new URL(call.url).searchParams.get("model"), "nova-3");
    assert.equal(call.init.headers["content-type"], "audio/wav");
    assert.equal(Buffer.from(call.init.body).toString(), "RIFF-WAVE");
    assert.deepEqual(output.data, { ok: true });
  });
});

test("bodyMode file: contentType overrides the file's own media type", async () => {
  await withUploadDirectory(async ({ allowedDirectory }) => {
    const fetchImpl = createScriptedFetch(() => ({ body: {} }));
    const { error } = await runOperation(uploadSpec({ contentType: "application/octet-stream" }), "listen", { file: join(allowedDirectory, "voice.wav") }, { fetchImpl, environment: { PROBE_UPLOAD_DIR: allowedDirectory } });
    if (error) throw error;
    assert.equal(fetchImpl.calls[0].init.headers["content-type"], "application/octet-stream");
  });
});

test("bodyMode file takes a public https URL, downloads it with the size cap, then uploads the bytes", async () => {
  const fetchImpl = createScriptedFetch((url, init, callIndex) => (callIndex === 0 ? new Response("REMOTE-AUDIO", { headers: { "content-type": "audio/mpeg" } }) : { body: { ok: true } }));
  const { error } = await runOperation(uploadSpec(), "listen", { file: "https://cdn.example.com/clip.mp3" }, { fetchImpl });
  if (error) throw error;
  assert.equal(fetchImpl.calls[0].url, "https://cdn.example.com/clip.mp3");
  assert.equal(fetchImpl.calls[0].headers.authorization, undefined, "no credential is sent to the file host");
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get("api_key"), null);
  assert.equal(fetchImpl.calls[1].init.headers["content-type"], "audio/mpeg");
  assert.equal(Buffer.from(fetchImpl.calls[1].init.body).toString(), "REMOTE-AUDIO");
  const tooLarge = createScriptedFetch(() => new Response(Buffer.alloc(2048), { headers: { "content-type": "audio/mpeg" } }));
  const oversized = await runOperation(uploadSpec(), "listen", { file: "https://cdn.example.com/big.mp3" }, { fetchImpl: tooLarge });
  assert.equal(oversized.error?.kind, "invalid_input");
  assert.equal(tooLarge.calls.length, 1, "nothing is uploaded");
});

test("bodyMode file refuses local files outside the allowlist, symlinks out of it, oversized files, a missing env and http URLs", async () => {
  await withUploadDirectory(async ({ root, allowedDirectory }) => {
    const environment = { PROBE_UPLOAD_DIR: allowedDirectory };
    await symlink(join(root, "outside.txt"), join(allowedDirectory, "link.wav"));
    await writeFile(join(allowedDirectory, "big.wav"), Buffer.alloc(2048));
    const refusals = [
      [join(root, "outside.txt"), environment],
      [join(allowedDirectory, "link.wav"), environment],
      [join(allowedDirectory, "big.wav"), environment],
      ["relative.wav", environment],
      [join(allowedDirectory, "voice.wav"), {}],
      ["http://cdn.example.com/a.wav", environment],
    ];
    for (const [filePath, refusalEnvironment] of refusals) {
      const { error, calls } = await runOperation(uploadSpec(), "listen", { file: filePath }, { environment: refusalEnvironment });
      assert.equal(error?.kind, "invalid_input", filePath);
      assert.equal(calls.length, 0, filePath);
    }
  });
});

test("file inputs refuse a FIFO without blocking (file and multipart bodies)", async (testContext) => {
  await withUploadDirectory(async ({ allowedDirectory }) => {
    const fifoPath = join(allowedDirectory, "pipe.wav");
    if (spawnSync("mkfifo", [fifoPath]).status !== 0) return testContext.skip("mkfifo is not available");
    const multipartSpec = uploadSpec({ bodyMode: "multipart", fileBody: undefined, multipart: { fileDirEnv: "PROBE_UPLOAD_DIR" } });
    for (const spec of [uploadSpec(), multipartSpec]) {
      const { error, calls } = await runOperation(spec, "listen", { file: fifoPath }, { environment: { PROBE_UPLOAD_DIR: allowedDirectory } });
      assert.equal(error?.kind, "invalid_input");
      assert.match(error.message, /regular file/);
      assert.equal(calls.length, 0);
    }
  });
});

test("query and header params are validated before the file is downloaded", async () => {
  const fetchImpl = createScriptedFetch(() => new Response("REMOTE", { headers: { "content-type": "audio/mpeg" } }));
  const { error } = await runOperation(uploadSpec(), "listen", { file: "https://cdn.example.com/clip.mp3", trace: "a\r\nInjected: 1" }, { fetchImpl });
  assert.equal(error?.kind, "invalid_input");
  assert.equal(fetchImpl.calls.length, 0, "the file is not fetched");
});

test("an unsafe file upload is not retried after a 5xx and says the outcome is unknown, with the checkHint", async () => {
  await withUploadDirectory(async ({ allowedDirectory }) => {
    const fetchImpl = createScriptedFetch(() => ({ status: 503, headers: { "retry-after": "0" }, body: { message: "down" } }));
    const { error } = await runOperation(uploadSpec(), "listen", { file: join(allowedDirectory, "voice.wav") }, { fetchImpl, environment: { PROBE_UPLOAD_DIR: allowedDirectory } });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(error?.retryable, false);
    assert.match(error.message, /outcome unknown/);
    assert.match(error.message, /To check: list recent requests/);
  });
});

test("an unsafe file upload is not retried after a network failure", async () => {
  await withUploadDirectory(async ({ allowedDirectory }) => {
    const fetchImpl = createScriptedFetch(() => {
      throw new TypeError("fetch failed");
    });
    const { error } = await runOperation(uploadSpec(), "listen", { file: join(allowedDirectory, "voice.wav") }, { fetchImpl, environment: { PROBE_UPLOAD_DIR: allowedDirectory } });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(error?.retryable, false);
    assert.match(error.message, /outcome unknown/);
  });
});

// The shared call budget for file inputs and the request is tested in transfer-budget.test.mjs.

test("an upload response is redacted and truncated for agent tools", async () => {
  await withUploadDirectory(async ({ allowedDirectory }) => {
    const fetchImpl = createScriptedFetch(() => ({ body: { echo: TEST_KEY, transcript: "x".repeat(200) } }));
    const spec = uploadSpec({}, { toolOutput: { maxChars: 50 } });
    const { output, error } = await runOperation(spec, "listen", { file: join(allowedDirectory, "voice.wav") }, { fetchImpl, environment: { PROBE_UPLOAD_DIR: allowedDirectory }, source: "tool" });
    if (error) throw error;
    assert.equal(JSON.stringify(output).includes(TEST_KEY), false);
    assert.equal(output.data.truncated, true);
  });
});

test("bodyMode file declares its upload directory env and validates its spec", () => {
  const definition = defineRestPlugin(uploadSpec());
  assert.ok(definition.extraEnv.includes("PROBE_UPLOAD_DIR"));
  const invalidSpecs = [
    [{ params: { file: { in: "body", type: "string", file: true }, other: { in: "body", type: "string" } } }, /bodyMode "file" needs exactly one body param/],
    [{ params: { file: { in: "body", type: "string" } } }, /bodyMode "file" needs exactly one body param/],
    [{ bodyMode: "json" }, /fileBody.*bodyMode "file"|file: true/],
    [{ fileBody: { fileDirEnv: "PROBE_UPLOAD_DIR", maxBytes: 1 } }, /maxBytes/],
    [{ constants: { body: { a: 1 } } }, /constant body/],
  ];
  for (const [overrides, expectedMessage] of invalidSpecs) assert.throws(() => defineRestPlugin(uploadSpec(overrides)), expectedMessage, JSON.stringify(overrides));
});
