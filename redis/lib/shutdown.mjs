/**
 * Closes pooled connections when the plugin process ends.
 *
 * graphrt ends a plugin by closing its stdin (the protocol loop then resolves)
 * and may also send signals; both paths close the connections once, then exit.
 * On stdin end, operations still running (the SDK lets them finish and reply)
 * get up to `drainTimeoutMs` first. A signal closes the connections at once.
 */

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5000;

/**
 * Creates an idempotent shutdown routine and installs signal handlers for it.
 *
 * @param options - Shutdown options (object)
 * @param options.pluginName - For log lines (string)
 * @param options.closeAllClients - Closes every pooled client (() => Promise<void>)
 * @param options.waitForRunningOperations - `(timeoutMs) => Promise<"idle" | "timeout">` (function, optional)
 * @param options.drainTimeoutMs - Longest wait for running operations on stdin end (number, default 30000)
 * @param options.processObject - Process to attach handlers to (default `process`)
 * @param options.exit - Exit function (default `process.exit`)
 * @returns `shutdown(reason, {letRunningFinish})` (function returning a Promise)
 *
 * @example
 * const shutdown = installShutdownHandlers({ pluginName: "redis", closeAllClients });
 * await shutdown("host closed the connection", { letRunningFinish: true });
 */
export function installShutdownHandlers({
  pluginName,
  closeAllClients,
  waitForRunningOperations = async () => "idle",
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  processObject = process,
  exit = (exitCode) => process.exit(exitCode),
}) {
  let shutdownPromise = null;
  const shutdown = (reason, { letRunningFinish = false } = {}) => {
    shutdownPromise ??= (async () => {
      console.error(`[${pluginName}] shutting down (${reason})`);
      if (letRunningFinish) {
        const outcome = await waitForRunningOperations(drainTimeoutMs).catch(() => "failed");
        if (outcome === "timeout") console.error(`[${pluginName}] operations still running after ${drainTimeoutMs} ms; closing their connections`);
      }
      await closeWithin(closeAllClients, CLOSE_TIMEOUT_MS, pluginName);
      exit(0);
    })();
    return shutdownPromise;
  };
  for (const signalName of SHUTDOWN_SIGNALS) processObject.on(signalName, () => shutdown(signalName));
  return shutdown;
}

async function closeWithin(closeAllClients, timeoutMs, pluginName) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  const closing = closeAllClients().catch((closeError) => console.error(`[${pluginName}] closing connections failed: ${closeError?.name ?? "error"}`));
  await Promise.race([closing, timeout]);
  clearTimeout(timer);
}
