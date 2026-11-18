/**
 * Closes the browser cleanly when the plugin process ends, so the Chromium
 * profile (and the WhatsApp session in it) is flushed to disk.
 *
 * graphrt ends a plugin by closing its stdin (the protocol loop then resolves)
 * and may also send signals; both paths close the browser once, then exit.
 */

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

/**
 * Creates an idempotent shutdown routine and installs signal handlers for it.
 *
 * @param options - Shutdown options (object)
 * @param options.closeAllClients - Closes every browser (() => Promise<void>)
 * @param options.processObject - Process to attach handlers to (default `process`)
 * @param options.exit - Exit function (default `process.exit`)
 * @returns `shutdown(reason)` that closes the browsers and exits (function)
 */
export function installShutdownHandlers({ closeAllClients, processObject = process, exit = (exitCode) => process.exit(exitCode) }) {
  let shutdownPromise = null;
  const shutdown = (reason) => {
    shutdownPromise ??= (async () => {
      console.error(`[whatsapp-web] shutting down (${reason})`);
      await closeAllClients().catch((closeError) => console.error(`[whatsapp-web] closing the browser failed: ${closeError.message}`));
      exit(0);
    })();
    return shutdownPromise;
  };
  for (const signalName of SHUTDOWN_SIGNALS) processObject.on(signalName, () => shutdown(signalName));
  return shutdown;
}
