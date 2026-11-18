/**
 * Cancellation helpers: make an AbortSignal stop in-flight browser work
 * immediately instead of only between steps.
 */
import { PluginError } from "../graphrt-plugin.mjs";

/**
 * Closes the browser as soon as `signal` aborts, which makes any pending
 * Playwright call (goto, waitForSelector, ...) reject right away.
 *
 * @param signal - Cancellation signal (AbortSignal | undefined)
 * @param browser - Object with an async `close()` (Playwright Browser)
 * @returns Function that removes the listener (() => void)
 */
export function bindAbortToBrowser(signal, browser) {
  if (!signal) return () => {};
  const closeBrowser = () => {
    browser.close().catch((closeError) => console.error(`[gmaps] browser close on cancel failed: ${closeError.message}`));
  };
  if (signal.aborted) {
    closeBrowser();
    return () => {};
  }
  signal.addEventListener("abort", closeBrowser, { once: true });
  return () => signal.removeEventListener("abort", closeBrowser);
}

/**
 * Reports a failure caused by cancellation as kind `cancelled`.
 *
 * @param error - Error thrown while the search ran (Error)
 * @param signal - Cancellation signal (AbortSignal | undefined)
 * @returns PluginError kind `cancelled` when aborted, otherwise `error` unchanged
 */
export function toCancelledIfAborted(error, signal) {
  if (!signal?.aborted) return error;
  return new PluginError("Search cancelled", { kind: "cancelled" });
}

/**
 * Creates a signal that aborts after `timeoutMs`. Used for tool calls, which
 * the SDK cannot cancel, so a browser never outlives the host's timeout.
 *
 * @param timeoutMs - Deadline in milliseconds (number)
 * @returns Signal that aborts at the deadline (AbortSignal)
 */
export function createDeadlineSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs);
}
