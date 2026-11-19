import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { DEFAULT_DATA_REF, DEFAULT_DATA_SHA256, MAX_DATASET_BYTES } from "../lib/dataset-loader.mjs";
import { createWilayahDefinition } from "../definition.mjs";

const PROVINCE_ROWS = Array.from({ length: 34 }, (_, index) => `('${String(11 + index)}','Provinsi ${index}')`);
const FIXTURE_SQL = `INSERT INTO wilayah (kode, nama)\nVALUES\n${PROVINCE_ROWS.join(",\n")};\n`;
const TAMPERED_SQL = FIXTURE_SQL.replace("Provinsi 0", "Provinsi X");
const sha256Of = (text) => createHash("sha256").update(text).digest("hex");
const FIXTURE_SHA256 = sha256Of(FIXTURE_SQL);
const sqlResponse = (body = FIXTURE_SQL) => ({ body, headers: { "content-type": "text/plain; charset=utf-8" } });

function createHarness({ environment = {}, responses = [sqlResponse()], fetchImpl } = {}) {
  const recordingFetch = fetchImpl ?? createRecordingFetch(responses);
  const definition = createWilayahDefinition({ pinnedSha256: FIXTURE_SHA256 });
  const runner = createOperationRunner(definition, environment, { fetchImpl: recordingFetch });
  return { run: async (operationName, args = {}) => (await runner(operationName, args, { source: "tool" })).data, calls: recordingFetch.calls };
}

async function withCacheDirectory(useDirectory) {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "wilayah-integrity-"));
  try {
    await useDirectory(cacheDirectory);
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
}

test("the pinned commit has its SHA-256 recorded", () => {
  assert.equal(DEFAULT_DATA_REF, "d68e8d5516f969d1905d0b2940f20034becb0db7");
  assert.equal(DEFAULT_DATA_SHA256, "c4c3396d9380d4edee072af1d9dff83573b574d7cd00a6562cf82e200e954031");
});

test("a pinned download with another SHA-256 is an api_error and is not cached", async () => {
  const { run, calls } = createHarness({ responses: [sqlResponse(TAMPERED_SQL), sqlResponse()] });
  await assert.rejects(run("list_provinces"), (error) => error.kind === "api_error" && error.message.includes("SHA-256"));
  assert.equal((await run("list_provinces")).length, 34);
  assert.equal(calls.length, 2);
});

test("WILAYAH_INDONESIA_DATA_SHA256 checks another ref; without it another ref is not checked", async () => {
  const branch = { WILAYAH_INDONESIA_DATA_REF: "master" };
  const unchecked = createHarness({ environment: branch, responses: [sqlResponse(TAMPERED_SQL)] });
  assert.equal((await unchecked.run("list_provinces")).length, 34);
  const mismatched = createHarness({ environment: { ...branch, WILAYAH_INDONESIA_DATA_SHA256: FIXTURE_SHA256 }, responses: [sqlResponse(TAMPERED_SQL)] });
  await assert.rejects(mismatched.run("list_provinces"), (error) => error.kind === "api_error" && error.message.includes("SHA-256"));
  const matched = createHarness({ environment: { ...branch, WILAYAH_INDONESIA_DATA_SHA256: FIXTURE_SHA256.toUpperCase() } });
  assert.equal((await matched.run("list_provinces")).length, 34);
});

test("a malformed WILAYAH_INDONESIA_DATA_SHA256 is invalid_input before any request", async () => {
  const { run, calls } = createHarness({ environment: { WILAYAH_INDONESIA_DATA_SHA256: "abc" } });
  await assert.rejects(run("list_provinces"), (error) => error.kind === "invalid_input" && error.message.includes("WILAYAH_INDONESIA_DATA_SHA256"));
  assert.equal(calls.length, 0);
});

test("a disk cache copy with the wrong SHA-256 is ignored, downloaded again and replaced", async () => {
  await withCacheDirectory(async (cacheDirectory) => {
    const cacheFile = join(cacheDirectory, `wilayah-${DEFAULT_DATA_REF}.sql`);
    await writeFile(cacheFile, TAMPERED_SQL);
    const { run, calls } = createHarness({ environment: { WILAYAH_INDONESIA_CACHE_DIR: cacheDirectory } });
    const provinces = await run("list_provinces");
    assert.equal(calls.length, 1);
    assert.equal(provinces.some((province) => province.name === "Provinsi X"), false);
    assert.equal(await readFile(cacheFile, "utf8"), FIXTURE_SQL);
  });
});

test("a disk cache copy with the right SHA-256 is used without a download", async () => {
  await withCacheDirectory(async (cacheDirectory) => {
    await writeFile(join(cacheDirectory, `wilayah-${DEFAULT_DATA_REF}.sql`), FIXTURE_SQL);
    const { run, calls } = createHarness({ environment: { WILAYAH_INDONESIA_CACHE_DIR: cacheDirectory }, responses: [] });
    assert.equal((await run("list_provinces")).length, 34);
    assert.equal(calls.length, 0);
  });
});

test("the download stops reading past MAX_DATASET_BYTES while streaming", async () => {
  let pulls = 0;
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  const endlessFetch = async () => {
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
    });
    return new Response(body, { status: 200 });
  };
  const { run } = createHarness({ fetchImpl: endlessFetch });
  await assert.rejects(run("list_provinces"), (error) => error.kind === "api_error" && error.retryable === false && error.message.includes(String(MAX_DATASET_BYTES)));
  assert.ok(pulls <= MAX_DATASET_BYTES / chunk.byteLength + 3, `read ${pulls} chunks`);
});

test("a declared Content-Length over MAX_DATASET_BYTES is refused without reading the body", async () => {
  let pulled = false;
  const declaredFetch = async () => {
    // highWaterMark 0: the stream only pulls when someone reads it.
    const body = new ReadableStream({ pull: (controller) => ((pulled = true), controller.close()) }, { highWaterMark: 0 });
    return new Response(body, { status: 200, headers: { "content-length": String(MAX_DATASET_BYTES + 1) } });
  };
  const { run } = createHarness({ fetchImpl: declaredFetch });
  await assert.rejects(run("list_provinces"), (error) => error.kind === "api_error");
  assert.equal(pulled, false);
});
