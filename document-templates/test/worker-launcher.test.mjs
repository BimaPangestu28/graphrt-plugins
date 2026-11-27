/**
 * The real worker process: a render round-trip through IPC, errors that keep
 * their kind, and kill on timeout and cancel (the last two with a stand-in
 * child script).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessRssBytes } from "../lib/isolated-task.mjs";
import { createWorkerLauncher } from "../lib/worker-launcher.mjs";
import { AS_TOOL, INVOICE_VALUES, SKIP_WITHOUT_LIBRARIES, readPageTexts, withDocumentRunner } from "./helpers.mjs";

const limits = { timeoutMs: 30000, maxMemoryMb: 512 };

async function withStandInWorker(scriptText, work) {
  const scriptDirectory = await mkdtemp(join(tmpdir(), "graphrt-document-worker-"));
  const scriptPath = join(scriptDirectory, "stand-in.mjs");
  await writeFile(scriptPath, scriptText);
  try {
    return await work(createWorkerLauncher({ fork: (_modulePath, args, forkOptions) => fork(scriptPath, args, forkOptions) }));
  } finally {
    await rm(scriptDirectory, { recursive: true, force: true });
  }
}

test("render_pdf through the real worker process writes a readable invoice", { skip: SKIP_WITHOUT_LIBRARIES }, () =>
  withDocumentRunner({ runTask: createWorkerLauncher() }, async ({ runOperation }) => {
    const result = await runOperation("render_pdf", { values: INVOICE_VALUES }, AS_TOOL);
    assert.equal(result.data.page_count, 1);
    assert.ok((await readPageTexts(await readFile(result.data.path)))[0].includes("Rp 11.100.000"));
  }));

test("an error in the worker keeps its kind and message", { skip: SKIP_WITHOUT_LIBRARIES }, async () => {
  const launch = createWorkerLauncher();
  await assert.rejects(launch("fill_pdf_form", { bytes: Buffer.from("%PDF-garbage"), fieldValues: {}, isFlattened: true }, limits), (error) => error.kind === "invalid_input" && /not a readable PDF/.test(error.message));
  await assert.rejects(launch("no_such_task", {}, limits), { kind: "plugin_error" });
});

test("a worker that never answers is killed at the timeout, and on cancel", () =>
  withStandInWorker("setInterval(() => {}, 1000);", async (launch) => {
    await assert.rejects(launch("render_layout", {}, { ...limits, timeoutMs: 300 }), { kind: "timeout" });
    const controller = new AbortController();
    const pending = launch("render_layout", {}, { ...limits, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, { kind: "cancelled" });
  }));

test("a worker that crashes is reported as a plugin error", () =>
  withStandInWorker("process.exit(3);", async (launch) => {
    await assert.rejects(launch("render_layout", {}, limits), (error) => error.kind === "plugin_error" && /stopped unexpectedly/.test(error.message));
  }));

test("the memory watchdog can read a process's memory on Linux and macOS; Windows has no `ps`, so only the heap cap and the timeout apply there", async () => {
  const rssBytes = await readProcessRssBytes(process.pid);
  if (process.platform === "win32") assert.equal(rssBytes, null);
  else assert.ok(rssBytes > 1024 * 1024, String(rssBytes));
});
