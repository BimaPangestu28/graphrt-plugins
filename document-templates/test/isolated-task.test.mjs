/**
 * The memory watchdog of isolated-task.mjs against a real process on the
 * operating system the tests run on: Linux reads /proc, macOS `ps`, Windows
 * `tasklist`. This file is identical in the document-templates, pdf-tools
 * and excel-csv plugins, like the file it tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIsolatedTaskRunner, parseTasklistMemoryBytes, readProcessRssBytes } from "../lib/isolated-task.mjs";

const MEBIBYTE = 1024 * 1024;
// Memory outside the V8 heap, which the heap cap does not see: 400 MB of buffers that are written to, so that
// the operating system really hands the pages out. The worker then waits to be stopped.
const MEMORY_HOG_SCRIPT = "const held = []; for (let index = 0; index < 100; index += 1) held.push(Buffer.alloc(4 * 1024 * 1024, 1)); setInterval(() => held.length, 1000);";

test("tasklist's memory column is read in every Windows language, and no row means no reading", () => {
  assert.equal(parseTasklistMemoryBytes('"node.exe","1234","Console","1","45,672 K"\r\n'), 45672 * 1024);
  assert.equal(parseTasklistMemoryBytes('"node.exe","1234","Console","1","45.672 K"'), 45672 * 1024);
  assert.equal(parseTasklistMemoryBytes('"node.exe","1234","Services","0","1 045 672 K"'), 1045672 * 1024);
  assert.equal(parseTasklistMemoryBytes('"node.exe","77","Console","1","812 K"'), 812 * 1024);
  assert.equal(parseTasklistMemoryBytes("INFO: No tasks are running which match the specified criteria."), null);
  assert.equal(parseTasklistMemoryBytes(""), null);
});

test("the memory of a running process can be read on this operating system", async () => {
  const rssBytes = await readProcessRssBytes(process.pid);
  assert.ok(rssBytes > 10 * MEBIBYTE && rssBytes < 4096 * MEBIBYTE, `${process.platform}: ${rssBytes}`);
  assert.equal(await readProcessRssBytes(2 ** 22 - 3), null);
});

test("a worker that takes more memory than its budget outside the heap is stopped by the watchdog", async () => {
  const scriptDirectory = await mkdtemp(join(tmpdir(), "graphrt-isolated-task-"));
  try {
    const workerPath = join(scriptDirectory, "memory-hog.mjs");
    await writeFile(workerPath, MEMORY_HOG_SCRIPT);
    const runTask = createIsolatedTaskRunner({ workerPath, displayName: "Memory test", memoryVariable: "TEST_MAX_MEMORY_MB" });
    await assert.rejects(runTask("hold", {}, { timeoutMs: 60000, maxMemoryMb: 128 }), (error) => error.kind === "invalid_input" && /Memory test used \d+ MB, over the 128 MB budget \(TEST_MAX_MEMORY_MB\)/.test(error.message));
  } finally {
    await rm(scriptDirectory, { recursive: true, force: true });
  }
});
