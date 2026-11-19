/**
 * Runs one executable with an argument array (never a shell) in its own
 * process group, so a timeout, a cancel or an output cap can kill the program
 * together with everything it started (SIGKILL to the whole group). The
 * group is also killed when the program exits, so nothing it left running in
 * the background outlives the call.
 *
 * stdout and stderr are each collected up to a cap; reaching it kills the
 * group and flags the stream as truncated. The program's output never reaches
 * the plugin's own stdout (the protocol).
 */
import { spawn as defaultSpawn } from "node:child_process";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { operationFailed, setupRequired } from "./errors.mjs";

/**
 * Kills a process group, ignoring "no such process".
 *
 * @param processGroupId - The group leader's pid (number)
 */
export function killProcessGroup(processGroupId) {
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (killError) {
    if (killError?.code !== "ESRCH") process.stderr.write(`shell-exec: could not kill process group ${processGroupId}: ${killError.message}\n`);
  }
}

/**
 * Creates the runner.
 *
 * @param dependencies - `{spawn, killGroup, now}` overrides for tests (object, optional)
 * @returns `(request) => Promise<{exitCode, signal, stdout, stderr, stdoutTruncated, stderrTruncated, durationMs}>`;
 *   request is `{executablePath, args, cwd, env, stdin, timeoutMs, maxOutputBytes, signal}` (function)
 */
export function createCommandRunner({ spawn = defaultSpawn, killGroup = killProcessGroup, now = Date.now } = {}) {
  return (request) => {
    if (request.signal?.aborted) return Promise.reject(cancelledRun());
    return new Promise((resolvePromise, rejectPromise) => startRun({ spawn, killGroup, now }, request, resolvePromise, rejectPromise));
  };
}

function startRun({ spawn, killGroup, now }, request, resolvePromise, rejectPromise) {
  const startedAt = now();
  const child = spawn(request.executablePath, request.args, {
    cwd: request.cwd,
    env: request.env,
    shell: false,
    detached: true,
    windowsHide: true,
    stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const stopGroup = () => {
    if (child.pid) killGroup(child.pid);
  };
  const output = { stdout: createCollector(request.maxOutputBytes, stopGroup), stderr: createCollector(request.maxOutputBytes, stopGroup) };
  let isSettled = false;
  const settle = (settleFunction, value) => {
    if (isSettled) return;
    isSettled = true;
    clearTimeout(timeoutTimer);
    request.signal?.removeEventListener("abort", onAbort);
    stopGroup();
    settleFunction(value);
  };
  const onAbort = () => settle(rejectPromise, cancelledRun());
  const timeoutTimer = setTimeout(() => settle(rejectPromise, timedOutRun(request.timeoutMs)), request.timeoutMs);
  request.signal?.addEventListener("abort", onAbort, { once: true });
  child.stdout.on("data", output.stdout.add);
  child.stderr.on("data", output.stderr.add);
  child.once("exit", stopGroup);
  child.once("error", (spawnError) => settle(rejectPromise, describeSpawnError(spawnError, request.executablePath)));
  child.once("close", (exitCode, signalName) => settle(resolvePromise, buildResult({ exitCode, signalName, output, durationMs: now() - startedAt })));
  writeStdin(child, request.stdin);
}

function writeStdin(child, stdinText) {
  if (stdinText === undefined) return;
  child.stdin.on("error", (stdinError) => {
    if (stdinError?.code !== "EPIPE") process.stderr.write(`shell-exec: could not write stdin: ${stdinError.message}\n`);
  });
  child.stdin.end(stdinText);
}

function createCollector(maxBytes, stopGroup) {
  const chunks = [];
  let collectedBytes = 0;
  let isTruncated = false;
  return {
    add: (chunk) => {
      if (isTruncated) return;
      const room = maxBytes - collectedBytes;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      collectedBytes += Math.min(chunk.length, room);
      if (chunk.length > room) {
        isTruncated = true;
        stopGroup();
      }
    },
    result: () => ({ bytes: Buffer.concat(chunks), isTruncated }),
  };
}

function buildResult({ exitCode, signalName, output, durationMs }) {
  const stdout = output.stdout.result();
  const stderr = output.stderr.result();
  return { exitCode, signal: signalName, stdout: stdout.bytes, stderr: stderr.bytes, stdoutTruncated: stdout.isTruncated, stderrTruncated: stderr.isTruncated, durationMs };
}

function cancelledRun() {
  return new PluginError("The command was cancelled; its process group was killed", { kind: "cancelled" });
}

function timedOutRun(timeoutMs) {
  return new PluginError(`The command exceeded the ${timeoutMs} ms timeout; its process group was killed`, { kind: "timeout" });
}

function describeSpawnError(spawnError, executablePath) {
  if (spawnError?.code === "ENOENT" || spawnError?.code === "EACCES") return setupRequired(`${executablePath} could not be started (${spawnError.code})`);
  return operationFailed(`${executablePath} could not be started: ${spawnError.message}`);
}
