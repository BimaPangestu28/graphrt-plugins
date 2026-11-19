/**
 * Runs a PDF engine task (pdf-worker.mjs) in a short-lived child process
 * under the resource budget of isolated-task.mjs: heap cap, RSS watchdog
 * (inflated streams live in typed arrays outside the V8 heap), timeout and
 * cancel, all ending in SIGKILL.
 */
import { fileURLToPath } from "node:url";
import { createIsolatedTaskRunner } from "./isolated-task.mjs";

const WORKER_PATH = fileURLToPath(new URL("./pdf-worker.mjs", import.meta.url));

/**
 * Creates a function that runs one task per child process.
 *
 * @param dependencies - `{fork, readRss, pollIntervalMs}` overrides for tests (object, optional)
 * @returns `(task, payload, {signal, timeoutMs, maxMemoryMb}) => Promise<{data, outputs?}>` (function)
 */
export function createWorkerLauncher(dependencies = {}) {
  return createIsolatedTaskRunner({ workerPath: WORKER_PATH, displayName: "PDF processing", memoryVariable: "PDF_TOOLS_MAX_MEMORY_MB", ...dependencies });
}
