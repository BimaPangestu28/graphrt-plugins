/**
 * Abortable sleep shared by retry waits and polling loops.
 */
import { PluginError } from "./graphrt-plugin.mjs";

/**
 * Waits `delayMs`, rejecting with kind `cancelled` as soon as `signal` aborts
 * (including when it is already aborted). The abort listener is always removed.
 *
 * @param delayMs - Delay in milliseconds (number)
 * @param signal - Cancellation signal (AbortSignal, optional)
 * @param cancelMessage - Message for the cancellation error (string)
 * @returns Promise that resolves after the delay
 * @throws PluginError kind `cancelled`
 */
export function sleepUnlessCancelled(delayMs, signal, cancelMessage = "Cancelled") {
  if (signal?.aborted) return Promise.reject(new PluginError(cancelMessage, { kind: "cancelled" }));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new PluginError(cancelMessage, { kind: "cancelled" }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
