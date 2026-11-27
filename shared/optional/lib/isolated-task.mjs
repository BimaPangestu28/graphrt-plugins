/**
 * Runs one parsing task in a short-lived child process under a resource budget.
 *
 * Library parsers (pdf-lib, pdfjs, exceljs, csv-parse) cannot be interrupted
 * and can be driven to allocate without end by a hostile file. Each call gets
 * its own process with:
 * - a V8 heap cap (`--max-old-space-size`), which does NOT cover typed arrays
 *   and other off-heap memory, so also
 * - an RSS watchdog: the parent polls the child's resident memory every
 *   `pollIntervalMs` and SIGKILLs it past the budget (on Windows a reading
 *   takes a `tasklist` run, so it happens a few times a second), and
 * - a timeout and cancel, both SIGKILL.
 * Bytes travel over IPC with the "advanced" serialisation (structured clone).
 * The child's stdout is ignored (it is never the plugin's protocol stream).
 *
 * This file is identical in the pdf-tools and excel-csv plugins; keep the copies in step.
 */
import { execFile } from "node:child_process";
import { fork as defaultFork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cancelled, operationFailed, timedOut } from "./errors.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";

const DEFAULT_POLL_INTERVAL_MS = 50;
const KIBIBYTE = 1024;
const MEMORY_READ_TIMEOUT_MS = 5000;

/**
 * Reads the memory column of `tasklist /FO CSV /NH` for one process: `"node.exe","1234","Console","1","45,672 K"`.
 * The thousands separator follows the Windows language ("45.672 K", "45 672 K"), the unit does not.
 *
 * @param tasklistOutput - What tasklist printed (string)
 * @returns Working set in bytes, or null when the output has no process row (number | null)
 */
export function parseTasklistMemoryBytes(tasklistOutput) {
  const memoryColumn = /"([^"]*\d[^"]*)\s*K"\s*$/m.exec(String(tasklistOutput).trim());
  const kibibytes = memoryColumn ? Number(memoryColumn[1].replace(/\D/g, "")) : Number.NaN;
  return Number.isFinite(kibibytes) && kibibytes > 0 ? kibibytes * KIBIBYTE : null;
}

function runMemoryCommand(command, commandArguments) {
  return new Promise((resolvePromise) => {
    execFile(command, commandArguments, { timeout: MEMORY_READ_TIMEOUT_MS, windowsHide: true }, (commandError, stdout) => resolvePromise(commandError ? "" : String(stdout)));
  });
}

/**
 * Reads a process's resident set size: /proc on Linux, `ps` on macOS, `tasklist` on Windows (working set).
 *
 * @param processId - Child process id (number)
 * @returns RSS in bytes, or null when it cannot be read (number | null)
 */
export async function readProcessRssBytes(processId) {
  if (process.platform === "linux") {
    const status = await readFile(`/proc/${processId}/status`, "utf8").catch(() => "");
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return match ? Number(match[1]) * KIBIBYTE : null;
  }
  if (process.platform === "win32") {
    // By full path: the plugin's PATH is whatever the host passed on.
    const tasklistPath = join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", "tasklist.exe");
    return parseTasklistMemoryBytes(await runMemoryCommand(tasklistPath, ["/FI", `PID eq ${processId}`, "/FO", "CSV", "/NH"]));
  }
  const kibibytes = Number((await runMemoryCommand("ps", ["-o", "rss=", "-p", String(processId)])).trim());
  return Number.isFinite(kibibytes) && kibibytes > 0 ? kibibytes * KIBIBYTE : null;
}

/**
 * Creates a runner for one worker script.
 *
 * @param options - `{workerPath, displayName, memoryVariable, fork, readRss, pollIntervalMs}`; fork/readRss are test overrides (object)
 * @returns `(task, payload, {signal, timeoutMs, maxMemoryMb}) => Promise<result>` (function)
 */
export function createIsolatedTaskRunner({ workerPath, displayName, memoryVariable, fork = defaultFork, readRss = readProcessRssBytes, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS }) {
  const setup = { workerPath, displayName, memoryVariable, fork, readRss, pollIntervalMs };
  return (task, payload, limits) => {
    if (limits.signal?.aborted) return Promise.reject(cancelled(displayName));
    return runInChild(setup, { task, payload }, limits);
  };
}

function runInChild(setup, message, { signal, timeoutMs, maxMemoryMb }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = setup.fork(setup.workerPath, [], { stdio: ["ignore", "ignore", "inherit", "ipc"], serialization: "advanced", execArgv: [`--max-old-space-size=${maxMemoryMb}`] });
    let isSettled = false;
    const finish = (settle, value) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeoutTimer);
      stopWatchdog();
      signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      settle(value);
    };
    const onAbort = () => finish(rejectPromise, cancelled(setup.displayName));
    const timeoutTimer = setTimeout(() => finish(rejectPromise, timedOut(setup.displayName, timeoutMs)), timeoutMs);
    const stopWatchdog = watchMemory(child, setup, maxMemoryMb, (rssBytes) => finish(rejectPromise, memoryExceeded(setup, maxMemoryMb, rssBytes)));
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("message", (response) => {
      if (response?.ok) finish(resolvePromise, response.result);
      else finish(rejectPromise, new PluginError(response?.error?.message ?? `${setup.displayName} failed`, { kind: response?.error?.kind ?? "plugin_error" }));
    });
    child.once("error", (spawnError) => finish(rejectPromise, operationFailed(`Could not start the ${setup.displayName} worker: ${spawnError.message}`)));
    child.once("exit", (exitCode, exitSignal) => finish(rejectPromise, describeUnexpectedExit(setup, exitCode, exitSignal, maxMemoryMb)));
    child.send(message);
  });
}

// Polls resident memory; the heap cap alone misses Buffers and typed arrays (e.g. inflated PDF streams).
function watchMemory(child, setup, maxMemoryMb, onExceeded) {
  const maxRssBytes = maxMemoryMb * KIBIBYTE * KIBIBYTE;
  let isPolling = false;
  const pollTimer = setInterval(async () => {
    if (isPolling || !child.pid) return;
    isPolling = true;
    const rssBytes = await setup.readRss(child.pid).catch(() => null);
    isPolling = false;
    if (rssBytes !== null && rssBytes > maxRssBytes) {
      child.kill("SIGKILL");
      onExceeded(rssBytes);
    }
  }, setup.pollIntervalMs);
  return () => clearInterval(pollTimer);
}

function memoryExceeded(setup, maxMemoryMb, rssBytes) {
  const usedMb = Math.round(rssBytes / KIBIBYTE / KIBIBYTE);
  return new PluginError(`${setup.displayName} used ${usedMb} MB, over the ${maxMemoryMb} MB budget (${setup.memoryVariable}), and was stopped; the file is too large or crafted to expand`, { kind: "invalid_input" });
}

function describeUnexpectedExit(setup, exitCode, exitSignal, maxMemoryMb) {
  const reason = exitSignal ?? `exit ${exitCode}`;
  return operationFailed(`The ${setup.displayName} worker stopped unexpectedly (${reason}); the file may be malformed or need more than ${maxMemoryMb} MB (${setup.memoryVariable})`);
}
