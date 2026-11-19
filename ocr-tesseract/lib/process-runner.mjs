/**
 * Runs a local program with an argument array (never a shell), a timeout,
 * cancel support and output caps.
 *
 * On timeout or cancel the process gets SIGKILL at once. stdout is collected up
 * to a cap (then the process is killed and the result says `stdoutTruncated`);
 * stderr keeps only its last bytes, for error messages. The program's stdin is
 * closed, and its output never reaches the plugin's own stdout (the protocol).
 * This file is identical in the ffmpeg and ocr-tesseract plugins; keep the copies in step.
 */
import { spawn as defaultSpawn } from "node:child_process";
import { cancelled, operationFailed, setupRequired, timedOut } from "./errors.mjs";

const DEFAULT_MAX_STDERR_BYTES = 16384;

/**
 * Creates a function that runs one program to completion.
 *
 * @param dependencies - `{spawn}` override for tests (object, optional)
 * @returns `(request) => Promise<{exitCode, signalCode, stdout, stdoutTruncated, stderr}>` (function); request is
 *   `{command, args, timeoutMs, signal, maxStdoutBytes, displayName, setupHint}` — `setupHint` is the message when the program is missing
 */
export function createProcessRunner({ spawn = defaultSpawn } = {}) {
  return (request) => {
    if (request.signal?.aborted) return Promise.reject(cancelled(request.displayName));
    return runToCompletion(spawn, request);
  };
}

function runToCompletion(spawn, request) {
  const { command, args, timeoutMs, signal, displayName } = request;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const output = createOutputCollector(request, () => killChild(child));
    let isSettled = false;
    const finish = (settle, value) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onAbort);
      killChild(child);
      settle(value);
    };
    const onAbort = () => finish(rejectPromise, cancelled(displayName));
    const timeoutTimer = setTimeout(() => finish(rejectPromise, timedOut(displayName, timeoutMs)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", output.addStdout);
    child.stderr.on("data", output.addStderr);
    child.once("error", (spawnError) => finish(rejectPromise, describeSpawnError(spawnError, request)));
    child.once("close", (exitCode, signalCode) => finish(resolvePromise, { exitCode, signalCode, ...output.result() }));
  });
}

function createOutputCollector({ maxStdoutBytes, maxStderrBytes = DEFAULT_MAX_STDERR_BYTES }, stopProgram) {
  const stdoutChunks = [];
  let stdoutBytes = 0;
  let stdoutTruncated = false;
  let stderrText = "";
  return {
    addStdout: (chunk) => {
      if (stdoutTruncated) return;
      const room = maxStdoutBytes - stdoutBytes;
      stdoutChunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      stdoutBytes += Math.min(chunk.length, room);
      if (chunk.length > room) {
        stdoutTruncated = true;
        stopProgram();
      }
    },
    addStderr: (chunk) => {
      stderrText = `${stderrText}${chunk.toString("utf8")}`.slice(-maxStderrBytes);
    },
    result: () => ({ stdout: Buffer.concat(stdoutChunks), stdoutTruncated, stderr: stderrText.trim() }),
  };
}

function killChild(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function describeSpawnError(spawnError, { command, displayName, setupHint }) {
  if (spawnError?.code === "ENOENT" || spawnError?.code === "EACCES") {
    return setupRequired(`${displayName} could not be started (${command}: ${spawnError.code}). ${setupHint}`);
  }
  return operationFailed(`${displayName} could not be started: ${spawnError.message}`);
}
