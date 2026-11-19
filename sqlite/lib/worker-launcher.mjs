/**
 * Runs a sqlite request in a short-lived child process.
 *
 * node:sqlite is synchronous and cannot interrupt a running statement, so each
 * call gets its own process: on timeout or cancel it is killed with SIGKILL,
 * which stops SQLite at once (an interrupted write is rolled back from the
 * journal the next time the file is opened). The child's stdout is ignored,
 * because the plugin's stdout carries the graphrt protocol.
 */
import { fork as defaultFork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cancelled, setupRequired } from "./errors.mjs";
import { mapSqliteError } from "./error-mapping.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";

const WORKER_PATH = fileURLToPath(new URL("./sqlite-worker.mjs", import.meta.url));
const MINIMUM_NODE_VERSION = [22, 13];

/**
 * Creates a function that runs requests in child processes.
 *
 * @param dependencies - `{fork, nodeVersion}` overrides for tests (object, optional)
 * @returns `(request, {signal, timeoutMs}) => Promise<result[]>` (function)
 */
export function createWorkerLauncher({ fork = defaultFork, nodeVersion = process.versions.node } = {}) {
  return (request, { signal, timeoutMs }) => {
    if (!isNodeSqliteAvailable(nodeVersion)) {
      return Promise.reject(setupRequired(`The sqlite plugin needs Node.js ${MINIMUM_NODE_VERSION.join(".")} or newer (built-in node:sqlite); this is Node.js ${nodeVersion}`));
    }
    if (signal?.aborted) return Promise.reject(cancelled("before opening the database"));
    return runInChild(fork, request, { signal, timeoutMs });
  };
}

/**
 * Tells whether node:sqlite is available without flags.
 *
 * @param nodeVersion - e.g. "22.13.0" (string)
 * @returns True from Node.js 22.13 on (boolean)
 */
export function isNodeSqliteAvailable(nodeVersion) {
  const [major, minor] = nodeVersion.split(".").map(Number);
  return major > MINIMUM_NODE_VERSION[0] || (major === MINIMUM_NODE_VERSION[0] && minor >= MINIMUM_NODE_VERSION[1]);
}

function runInChild(fork, request, { signal, timeoutMs }) {
  const isWrite = request.mode === "write";
  return new Promise((resolve, reject) => {
    const child = fork(WORKER_PATH, [], { stdio: ["ignore", "ignore", "inherit", "ipc"], execArgv: ["--disable-warning=ExperimentalWarning"] });
    let isSettled = false;
    const finish = (settleFunction, value) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      settleFunction(value);
    };
    const writeNote = isWrite ? "the statement may or may not have been applied; check before retrying" : "";
    const onAbort = () => finish(reject, cancelled(writeNote));
    const timeoutTimer = setTimeout(() => {
      finish(reject, new PluginError(`SQLite statement exceeded the ${timeoutMs} ms timeout and was stopped${writeNote ? `; ${writeNote}` : ""}`, { kind: "timeout" }));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("message", (response) => {
      if (response?.ok) finish(resolve, response.results);
      else finish(reject, mapSqliteError(response?.error ?? {}));
    });
    child.once("error", (spawnError) => finish(reject, new PluginError(`Could not start the sqlite worker: ${spawnError.message}`, { kind: "plugin_error" })));
    child.once("exit", (exitCode, exitSignal) => {
      finish(reject, new PluginError(`The sqlite worker stopped unexpectedly (${exitSignal ?? `exit ${exitCode}`})${writeNote ? `; ${writeNote}` : ""}`, { kind: "plugin_error" }));
    });
    child.send(request);
  });
}
