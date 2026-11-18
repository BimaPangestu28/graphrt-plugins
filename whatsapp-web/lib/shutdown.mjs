/**
 * Closes the browser cleanly when the plugin process ends, so the Chromium
 * profile (and the WhatsApp session in it) is flushed to disk.
 *
 * graphrt ends a plugin by closing its stdin (the protocol loop then resolves)
 * and may also send signals; both paths close the browser once, then exit.
 * On stdin end, operations still running (the SDK lets them finish and reply)
 * get up to `drainTimeoutMs` before the browser is closed under them. A signal
 * closes the browser at once.
 */

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
export const DEFAULT_DRAIN_TIMEOUT_MS = 60000;

/**
 * Creates an idempotent shutdown routine and installs signal handlers for it.
 *
 * @param options - Shutdown options (object)
 * @param options.closeAllClients - Closes every browser (() => Promise<void>)
 * @param options.waitForRunningOperations - `(timeoutMs) => Promise<"idle" | "timeout">` (function, optional)
 * @param options.drainTimeoutMs - Longest wait for running operations on stdin end (number, default 60000)
 * @param options.processObject - Process to attach handlers to (default `process`)
 * @param options.exit - Exit function (default `process.exit`)
 * @returns `shutdown(reason, {letRunningFinish})` that closes the browsers and exits (function)
 */
export function installShutdownHandlers({
  closeAllClients,
  waitForRunningOperations = async () => "idle",
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  processObject = process,
  exit = (exitCode) => process.exit(exitCode),
}) {
  let shutdownPromise = null;
  const shutdown = (reason, { letRunningFinish = false } = {}) => {
    shutdownPromise ??= (async () => {
      console.error(`[whatsapp-web] shutting down (${reason})`);
      if (letRunningFinish) await drainRunningOperations(waitForRunningOperations, drainTimeoutMs);
      await closeAllClients().catch((closeError) => console.error(`[whatsapp-web] closing the browser failed: ${closeError.message}`));
      exit(0);
    })();
    return shutdownPromise;
  };
  for (const signalName of SHUTDOWN_SIGNALS) processObject.on(signalName, () => shutdown(signalName));
  return shutdown;
}

async function drainRunningOperations(waitForRunningOperations, drainTimeoutMs) {
  const outcome = await waitForRunningOperations(drainTimeoutMs).catch((waitError) => {
    console.error(`[whatsapp-web] waiting for running operations failed: ${waitError.message}`);
    return "failed";
  });
  if (outcome === "timeout") {
    console.error(`[whatsapp-web] operations still running after ${drainTimeoutMs} ms; closing the browser aborts them`);
  }
}
