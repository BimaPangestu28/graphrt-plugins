/**
 * The real worker process: a task round-trip through IPC, and kill on timeout, cancel and crashes
 * (the last three with a stand-in child script).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerLauncher } from "../lib/worker-launcher.mjs";
import { SKIP_WITHOUT_LIBRARIES, buildFlateBombPdf, pdfLib } from "./helpers.mjs";

const limits = { timeoutMs: 20000, maxMemoryMb: 256 };

async function withStandInWorker(scriptText, work, launcherOverrides = {}) {
  const scriptDirectory = await mkdtemp(join(tmpdir(), "graphrt-pdf-worker-"));
  const scriptPath = join(scriptDirectory, "stand-in.mjs");
  await writeFile(scriptPath, scriptText);
  try {
    return await work(createWorkerLauncher({ fork: (_modulePath, args, options) => fork(scriptPath, args, options), ...launcherOverrides }));
  } finally {
    await rm(scriptDirectory, { recursive: true, force: true });
  }
}

test("a task runs in a child process and its bytes come back intact", { skip: SKIP_WITHOUT_LIBRARIES }, async () => {
  const document = await pdfLib.PDFDocument.create();
  document.addPage([100, 100]);
  const bytes = await document.save();
  const launch = createWorkerLauncher();
  const { data, outputs } = await launch("rotate", { bytes, degrees: 90, maxPages: 10 }, limits);
  assert.deepEqual(data.rotated_pages, [1]);
  assert.ok(outputs[0] instanceof Uint8Array && outputs[0].length > 100);
  await assert.rejects(launch("extract_pages", { bytes: Buffer.from("%PDF-garbage"), pages: "1", maxPages: 10 }, limits), { kind: "invalid_input" });
});

test("a worker that never answers is killed at the timeout", () =>
  withStandInWorker("setInterval(() => {}, 1000);", async (launch) => {
    await assert.rejects(launch("inspect", {}, { ...limits, timeoutMs: 300 }), { kind: "timeout" });
  }));

test("cancel kills the worker", () =>
  withStandInWorker("setInterval(() => {}, 1000);", async (launch) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(launch("inspect", {}, { ...limits, signal: controller.signal }), { kind: "cancelled" });
    await assert.rejects(launch("inspect", {}, { ...limits, signal: AbortSignal.abort() }), { kind: "cancelled" });
  }));

test("RSS watchdog: a worker whose resident memory passes the budget is killed with invalid_input", () =>
  withStandInWorker("setInterval(() => {}, 1000);", async (launch) => {
    await assert.rejects(launch("inspect", {}, { ...limits, maxMemoryMb: 256 }), (error) => error.kind === "invalid_input" && /over the 256 MB budget \(PDF_TOOLS_MAX_MEMORY_MB\)/.test(error.message));
  }, { readRss: async () => 300 * 1024 * 1024, pollIntervalMs: 10 }));

test("review regression: a 400 MB Flate bomb in a small PDF is stopped by the RSS watchdog, not the heap cap", { skip: SKIP_WITHOUT_LIBRARIES, timeout: 60000 }, async () => {
  const bombPdf = buildFlateBombPdf(400);
  assert.ok(bombPdf.length < 1024 * 1024);
  const launch = createWorkerLauncher();
  for (const task of ["extract_text"]) {
    await assert.rejects(launch(task, { bytes: bombPdf, maxChars: 1000, degrees: 90, maxPages: 10 }, { timeoutMs: 50000, maxMemoryMb: 200 }), (error) => error.kind === "invalid_input" && /budget/.test(error.message), task);
  }
});

test("a crashing worker is a plugin_error that mentions the memory limit", () =>
  withStandInWorker("process.exit(134);", async (launch) => {
    await assert.rejects(launch("inspect", {}, limits), (error) => error.kind === "plugin_error" && /PDF_TOOLS_MAX_MEMORY_MB/.test(error.message));
  }));
