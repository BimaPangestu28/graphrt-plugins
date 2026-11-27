/**
 * Runs a document engine task (document-worker.mjs) in a short-lived child
 * process under the resource budget of isolated-task.mjs: heap cap, RSS
 * watchdog, timeout and cancel, all ending in SIGKILL.
 */
import { fileURLToPath } from "node:url";
import { createIsolatedTaskRunner } from "./isolated-task.mjs";

const WORKER_PATH = fileURLToPath(new URL("./document-worker.mjs", import.meta.url));

/**
 * Creates a function that runs one task per child process.
 *
 * @param dependencies - `{fork, readRss, pollIntervalMs}` overrides for tests (object, optional)
 * @returns `(task, payload, {signal, timeoutMs, maxMemoryMb}) => Promise<{data, outputs?}>` (function)
 */
export function createWorkerLauncher(dependencies = {}) {
  return createIsolatedTaskRunner({ workerPath: WORKER_PATH, displayName: "Document processing", memoryVariable: "DOCUMENT_TEMPLATES_MAX_MEMORY_MB", ...dependencies });
}
