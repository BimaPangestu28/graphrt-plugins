/**
 * Polls an asynchronous job (media container, upload, publish) until it
 * finishes, fails, times out or is cancelled.
 */
import { PluginError } from "./graphrt-plugin.mjs";
import { sleepUnlessCancelled } from "./sleep.mjs";

/**
 * Polls `readStatus` until `isDone` or `isFailed`.
 *
 * @param options - Polling options (object)
 * @param options.readStatus - `async () => statusResult` (function)
 * @param options.isDone - `(statusResult) => boolean` (function)
 * @param options.isFailed - `(statusResult) => false | string`; a string is the failure reason (function)
 * @param options.intervalMs - Delay between polls (number)
 * @param options.timeoutMs - Give up after this long (number)
 * @param options.signal - Cancellation signal (AbortSignal, optional)
 * @returns The status result that satisfied `isDone` (Promise<object>)
 * @throws PluginError kinds `api_error` (failed), `timeout` (not retryable), `cancelled`, or a non-transient
 *   error thrown by `readStatus`. Transient read errors (network, rate limit, 5xx) are retried until the deadline.
 */
export async function pollUntilDone({ readStatus, isDone, isFailed, intervalMs, timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    throwIfCancelled(signal);
    const statusResult = await readStatusTolerantly(readStatus);
    if (statusResult !== TRANSIENT_FAILURE) {
      if (isDone(statusResult)) return statusResult;
      const failureReason = isFailed(statusResult);
      if (failureReason) throw new PluginError(`Processing failed: ${failureReason}`, { kind: "api_error" });
    }
    if (Date.now() + intervalMs > deadline) {
      // Not retryable: the job was already started and may still finish, so a blind re-run could duplicate it.
      throw new PluginError(`Still processing after ${Math.round(timeoutMs / 1000)} s; check its status before retrying`, {
        kind: "timeout",
        retryable: false,
      });
    }
    await sleepUnlessCancelled(intervalMs, signal, CANCEL_MESSAGE);
  }
}

// A status read is safe to repeat, so brief API hiccups must not abort a job that is going fine.
async function readStatusTolerantly(readStatus) {
  try {
    return await readStatus();
  } catch (statusError) {
    if (TRANSIENT_KINDS.has(statusError?.kind)) {
      console.error(`[poll] status check failed, will retry: ${statusError.message}`);
      return TRANSIENT_FAILURE;
    }
    throw statusError;
  }
}

/**
 * Reads the poll interval, letting tests shorten it via GRAPHRT_POLL_INTERVAL_MS.
 *
 * @param environment - Environment variables (object)
 * @param defaultIntervalMs - Interval used in production (number)
 * @returns Interval in milliseconds (number)
 */
export function resolvePollInterval(environment, defaultIntervalMs) {
  const overrideMs = Number(environment?.GRAPHRT_POLL_INTERVAL_MS);
  return Number.isFinite(overrideMs) && overrideMs >= 0 ? overrideMs : defaultIntervalMs;
}

const CANCEL_MESSAGE = "Cancelled while waiting for processing";
const TRANSIENT_KINDS = new Set(["network_error", "rate_limited", "api_error"]);
const TRANSIENT_FAILURE = Symbol("transient status read failure");

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new PluginError(CANCEL_MESSAGE, { kind: "cancelled" });
}
