/**
 * Runs a child process (no shell) with stdin text, a timeout and cancellation.
 * The process is killed on timeout or abort.
 */
import { spawn } from "node:child_process";
import { PluginError } from "./shared/graphrt-plugin.mjs";

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Runs `file args` and collects its output.
 *
 * @param file - Absolute executable path (string)
 * @param args - Arguments, passed without a shell (string[])
 * @param options - Run options (object)
 * @param options.stdinText - Text written to stdin, then stdin is closed (string, optional)
 * @param options.signal - Cancels and kills the process (AbortSignal, optional)
 * @param options.timeoutMs - Kills the process after this long (number, default 30000)
 * @param options.spawnProcess - spawn replacement for tests (function, optional)
 * @returns `{exitCode, stdout, stderr}` (Promise<object>)
 * @throws PluginError kinds `timeout`, `cancelled`, `plugin_error` (could not start, or output too large)
 *
 * @example
 * const { exitCode, stdout } = await runProcess("/usr/bin/osascript", ["-l", "JavaScript", "-e", source], { stdinText: "{}" });
 */
export function runProcess(file, args, { stdinText = "", signal, timeoutMs = DEFAULT_TIMEOUT_MS, spawnProcess = spawn } = {}) {
  if (signal?.aborted) return Promise.reject(cancelledError(file));
  return new Promise((resolve, reject) => {
    const child = spawnProcess(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    const output = { stdout: "", stderr: "", bytes: 0 };
    const settle = createSettler(child, signal, { resolve, reject });
    const timer = setTimeout(() => settle.fail(new PluginError(`${file} timed out after ${timeoutMs} ms`, { kind: "timeout" })), timeoutMs);
    settle.onDone(() => clearTimeout(timer));
    signal?.addEventListener("abort", settle.abortListener, { once: true });
    collectOutput(child, output, settle);
    child.on("error", (error) => settle.fail(new PluginError(`Could not start ${file}: ${error.message}`, { kind: "plugin_error" })));
    child.on("close", (exitCode) => settle.succeed({ exitCode, stdout: output.stdout, stderr: output.stderr }));
    child.stdin.on("error", () => {}); // EPIPE when the process exits early; the exit code tells the story.
    child.stdin.end(stdinText);
  });
}

function createSettler(child, signal, { resolve, reject }) {
  let isSettled = false;
  const doneCallbacks = [];
  const finish = (settleFunction, value) => {
    if (isSettled) return;
    isSettled = true;
    signal?.removeEventListener("abort", settler.abortListener);
    doneCallbacks.forEach((callback) => callback());
    settleFunction(value);
  };
  const settler = {
    succeed: (value) => finish(resolve, value),
    fail: (error) => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      finish(reject, error);
    },
    onDone: (callback) => doneCallbacks.push(callback),
    abortListener: () => settler.fail(cancelledError(child.spawnfile ?? "process")),
  };
  return settler;
}

function collectOutput(child, output, settle) {
  // setEncoding keeps multi-byte characters intact across chunk boundaries.
  const append = (streamName) => (chunkText) => {
    output.bytes += Buffer.byteLength(chunkText);
    if (output.bytes > MAX_OUTPUT_BYTES) {
      settle.fail(new PluginError(`Process output exceeded ${MAX_OUTPUT_BYTES} bytes`, { kind: "plugin_error" }));
      return;
    }
    output[streamName] += chunkText;
  };
  for (const streamName of ["stdout", "stderr"]) {
    child[streamName].setEncoding("utf8");
    child[streamName].on("data", append(streamName));
  }
}

function cancelledError(file) {
  return new PluginError(`Cancelled while running ${file}`, { kind: "cancelled" });
}
