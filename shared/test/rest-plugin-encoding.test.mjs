import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSpec, createScriptedFetch, runOperation, TEST_KEY } from "./fixtures/rest-test-helpers.mjs";

const queryEntries = (url) => [...new URL(url).searchParams].filter(([name]) => name !== "api_key");

// --- 5. query array styles and form bodies ---------------------------------------------------------

test("query arrays: comma (default), repeat and brackets styles per param", async () => {
  const spec = buildSpec([
    {
      name: "arrays",
      title: "A",
      description: "d",
      path: "/a",
      params: {
        ids: { in: "query", type: "array", items: { type: "string" } },
        tags: { in: "query", type: "array", items: { type: "string" }, style: "repeat" },
        expand: { in: "query", type: "array", items: { type: "string" }, style: "brackets" },
      },
    },
  ]);
  const { calls } = await runOperation(spec, "arrays", { ids: ["a", "b"], tags: ["x", "y"], expand: ["p", "q"] });
  assert.deepEqual(queryEntries(calls[0].url), [["ids", "a,b"], ["tags", "x"], ["tags", "y"], ["expand[]", "p"], ["expand[]", "q"]]);
});

const formOperation = (formArrays) => ({
  name: "charge",
  title: "C",
  description: "d",
  method: "POST",
  write: "unsafe",
  bodyMode: "form",
  ...(formArrays ? { formArrays } : {}),
  path: "/charges",
  params: {
    order: { in: "body", type: "string", wireName: "metadata.order" },
    tags: { in: "body", type: "array", items: { type: "string" } },
    items: { in: "body", type: "array", items: { type: "object" } },
  },
});

test("form bodies nest dotted wireNames as brackets and encode arrays as [] by default", async () => {
  const { calls } = await runOperation(buildSpec([formOperation()]), "charge", { order: "o1", tags: ["x", "y"], items: [{ price: "p1", quantity: 2 }] });
  assert.equal(calls[0].headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual([...new URLSearchParams(calls[0].body)], [["metadata[order]", "o1"], ["tags[]", "x"], ["tags[]", "y"], ["items[0][price]", "p1"], ["items[0][quantity]", "2"]]);
});

test("form arrays can be repeated or indexed", async () => {
  const repeated = await runOperation(buildSpec([formOperation("repeat")]), "charge", { tags: ["x", "y"] });
  assert.deepEqual([...new URLSearchParams(repeated.calls[0].body)], [["tags", "x"], ["tags", "y"]]);
  const indexed = await runOperation(buildSpec([formOperation("indexed")]), "charge", { tags: ["x", "y"] });
  assert.deepEqual([...new URLSearchParams(indexed.calls[0].body)], [["tags[0]", "x"], ["tags[1]", "y"]]);
});

// --- d. constants, h. text / content types, i. multi-segment paths -----------------------------------

test("constants add fixed query, body and header values that args cannot override", async () => {
  const spec = buildSpec([
    {
      name: "chat",
      title: "C",
      description: "d",
      method: "POST",
      write: "unsafe",
      path: "/chat",
      params: { prompt: { in: "body", type: "string", required: true } },
      constants: { query: { "api-version": "2026-01" }, body: { stream: false, "options.mode": "fast" }, headers: { "OpenAI-Beta": "assistants=v2", Accept: "application/json" } },
    },
  ]);
  const { calls } = await runOperation(spec, "chat", { prompt: "hi" });
  assert.deepEqual(queryEntries(calls[0].url), [["api-version", "2026-01"]]);
  assert.deepEqual(JSON.parse(calls[0].body), { prompt: "hi", stream: false, options: { mode: "fast" } });
  assert.equal(calls[0].headers["openai-beta"], "assistants=v2");
  assert.equal(calls[0].headers.accept, "application/json");
});

test("contentType overrides the JSON content type (merge-patch) and text mode sends a string or NDJSON", async () => {
  const spec = buildSpec([
    { name: "patch", title: "P", description: "d", method: "PATCH", write: "idempotent", contentType: "application/merge-patch+json", path: "/x", params: { title: { in: "body", type: "string" } } },
    { name: "bulk", title: "B", description: "d", method: "POST", write: "unsafe", bodyMode: "text", contentType: "application/x-ndjson", path: "/_bulk", params: { lines: { in: "body", type: "array", items: { type: "object" }, required: true } } },
    { name: "note", title: "N", description: "d", method: "POST", write: "unsafe", bodyMode: "text", path: "/notes", params: { text: { in: "body", type: "string", required: true } } },
  ]);
  const patch = await runOperation(spec, "patch", { title: "T" });
  assert.equal(patch.calls[0].headers["content-type"], "application/merge-patch+json");
  assert.equal(patch.calls[0].body, '{"title":"T"}');
  const bulk = await runOperation(spec, "bulk", { lines: [{ index: {} }, { a: 1 }] });
  assert.equal(bulk.calls[0].headers["content-type"], "application/x-ndjson");
  assert.equal(bulk.calls[0].body, '{"index":{}}\n{"a":1}\n');
  const note = await runOperation(spec, "note", { text: "plain words" });
  assert.equal(note.calls[0].headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(note.calls[0].body, "plain words");
});

test("{+path} placeholders keep slashes but encode each segment and refuse dot segments", async () => {
  const spec = buildSpec([{ name: "file", title: "F", description: "d", path: "/repos/{repo}/contents/{+file_path}", params: { repo: { in: "path", type: "string", required: true }, file_path: { in: "path", type: "string", required: true } } }]);
  const { calls } = await runOperation(spec, "file", { repo: "r", file_path: "src/a b/c.md" });
  assert.equal(new URL(calls[0].url).pathname, "/v1/repos/r/contents/src/a%20b/c.md");
  for (const unsafePath of ["src/../secret", "./a", "a//b", "/abs"]) {
    const { error, calls: refusedCalls } = await runOperation(spec, "file", { repo: "r", file_path: unsafePath });
    assert.equal(error?.kind, "invalid_input", unsafePath);
    assert.equal(refusedCalls.length, 0);
  }
});

// --- e. idempotency keys ----------------------------------------------------------------------------

test("idempotencyKeyHeader makes an unsafe POST retryable with the same key on every attempt", async () => {
  const spec = buildSpec([{ name: "pay", title: "P", description: "d", method: "POST", write: "unsafe", path: "/payments", params: {} }], { idempotencyKeyHeader: "Idempotency-Key" });
  const { output, calls, error } = await runOperation(spec, "pay", {}, { responses: [{ status: 503, headers: { "retry-after": "0" } }, { body: { id: "p1" } }] });
  if (error) throw error;
  assert.equal(calls.length, 2);
  assert.match(calls[0].headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  assert.equal(calls[0].headers["idempotency-key"], calls[1].headers["idempotency-key"]);
  assert.deepEqual(output.data, { id: "p1" });
  const next = await runOperation(spec, "pay", {}, { responses: [{ body: {} }] });
  assert.notEqual(next.calls[0].headers["idempotency-key"], calls[0].headers["idempotency-key"], "a new call gets a new key");
});

test("when every keyed attempt fails, the error is not retryable and names the key", async () => {
  const spec = buildSpec([{ name: "pay", title: "P", description: "d", method: "POST", write: "unsafe", path: "/payments", params: {} }], { idempotencyKeyHeader: "Idempotency-Key", maxRetries: 1 });
  const failure = { status: 503, headers: { "retry-after": "0" } };
  const { error, calls } = await runOperation(spec, "pay", {}, { responses: [failure, failure] });
  assert.equal(error?.retryable, false);
  assert.match(error.message, /outcome unknown/);
  assert.ok(error.message.includes(calls[0].headers["idempotency-key"]));
});

// --- 6. custom auth signing ---------------------------------------------------------------------------

test("custom auth signs the final method, URL and encoded body (HMAC example)", async () => {
  const authorize = ({ method, url, body, headers, credential }) => {
    const timestamp = "1700000000";
    headers["x-timestamp"] = timestamp;
    headers["x-signature"] = createHmac("sha256", credential).update(`${timestamp}${method}${new URL(url).pathname}${new URL(url).search}${body ?? ""}`).digest("hex");
  };
  const spec = buildSpec([{ name: "order", title: "O", description: "d", method: "POST", write: "unsafe", path: "/orders", params: { sku: { in: "body", type: "string" }, dry: { in: "query", type: "boolean" } } }], { auth: { type: "custom", env: "PROBE_KEY", authorize } });
  const { calls } = await runOperation(spec, "order", { sku: "A1", dry: true });
  const expected = createHmac("sha256", TEST_KEY).update('1700000000POST/v1/orders?dry=true{"sku":"A1"}').digest("hex");
  assert.equal(calls[0].headers["x-signature"], expected);
});

// --- a. multipart with file inputs ------------------------------------------------------------------------

async function withUploadDirectory(runWithDirectory) {
  const root = await mkdtemp(join(tmpdir(), "rest-upload-"));
  const allowedDirectory = join(root, "allowed");
  await mkdir(allowedDirectory);
  await writeFile(join(allowedDirectory, "voice.mp3"), "MP3DATA");
  await writeFile(join(root, "outside.txt"), "SECRET");
  try {
    return await runWithDirectory({ root, allowedDirectory });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const multipartSpec = () =>
  buildSpec([
    {
      name: "transcribe",
      title: "T",
      description: "d",
      method: "POST",
      write: "idempotent",
      bodyMode: "multipart",
      path: "/audio/transcriptions",
      multipart: { fileDirEnv: "PROBE_UPLOAD_DIR", maxFileBytes: 1024 },
      params: { file: { in: "body", type: "string", file: true, required: true }, model: { in: "body", type: "string", default: "whisper-1" } },
    },
  ]);

test("multipart sends a local file from the allowlisted directory plus plain fields", async () => {
  await withUploadDirectory(async ({ allowedDirectory }) => {
    const { calls, error } = await runOperation(multipartSpec(), "transcribe", { file: join(allowedDirectory, "voice.mp3") }, { environment: { PROBE_UPLOAD_DIR: allowedDirectory } });
    if (error) throw error;
    const formData = calls[0].init?.body ?? calls[0].formData;
    assert.ok(formData instanceof FormData);
    assert.equal(formData.get("model"), "whisper-1");
    const uploadedFile = formData.get("file");
    assert.equal(uploadedFile.name, "voice.mp3");
    assert.equal(uploadedFile.type, "audio/mpeg");
    assert.equal(await uploadedFile.text(), "MP3DATA");
  });
});

test("multipart refuses files outside the allowlist, symlinks out of it, missing env and oversized files", async () => {
  await withUploadDirectory(async ({ root, allowedDirectory }) => {
    const environment = { PROBE_UPLOAD_DIR: allowedDirectory };
    await symlink(join(root, "outside.txt"), join(allowedDirectory, "link.txt"));
    await writeFile(join(allowedDirectory, "big.bin"), Buffer.alloc(2048));
    const refusals = [
      [join(root, "outside.txt"), environment],
      [join(allowedDirectory, "..", "outside.txt"), environment],
      [join(allowedDirectory, "link.txt"), environment],
      [join(allowedDirectory, "big.bin"), environment],
      ["relative/voice.mp3", environment],
      [join(allowedDirectory, "voice.mp3"), {}],
      ["http://cdn.example.com/a.mp3", environment],
    ];
    for (const [filePath, refusalEnvironment] of refusals) {
      const { error, calls } = await runOperation(multipartSpec(), "transcribe", { file: filePath }, { environment: refusalEnvironment });
      assert.equal(error?.kind, "invalid_input", filePath);
      assert.equal(calls.length, 0, filePath);
    }
  });
});

test("multipart can take a file from a public https URL, with the size cap", async () => {
  const fetchImpl = createScriptedFetch((url, init, callIndex) => (callIndex === 0 ? new Response("REMOTE", { headers: { "content-type": "audio/wav" } }) : { body: { text: "hi" } }));
  const { calls, error } = await runOperation(multipartSpec(), "transcribe", { file: "https://cdn.example.com/clip.wav" }, { fetchImpl });
  if (error) throw error;
  const uploadedFile = calls[1].init.body.get("file");
  assert.equal(uploadedFile.name, "clip.wav");
  assert.equal(await uploadedFile.text(), "REMOTE");
});
