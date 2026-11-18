/**
 * Counts running operations so shutdown can let them finish (a page that is
 * still loading must not lose its browser) before closing the browser.
 */

/**
 * Creates an operation tracker.
 *
 * @returns `{track(startOperation), runningCount(), waitForIdle(timeoutMs)}` (object)
 *
 * @example
 * const tracker = createOperationTracker();
 * const chats = await tracker.track(() => fetchPage(args));
 * await tracker.waitForIdle(60000); // "idle" or "timeout"
 */
export function createOperationTracker() {
  const runningOperations = new Set();
  return {
    /** Runs `startOperation()` and tracks it until it settles; returns its own result. */
    track(startOperation) {
      const operationPromise = (async () => startOperation())();
      runningOperations.add(operationPromise);
      const forgetOperation = () => runningOperations.delete(operationPromise);
      operationPromise.then(forgetOperation, forgetOperation);
      return operationPromise;
    },
    runningCount: () => runningOperations.size,
    /**
     * Waits until no operation runs (also ones started while waiting), at most `timeoutMs`.
     *
     * @param timeoutMs - Upper bound for the wait (number)
     * @returns "idle" or "timeout" (Promise<string>)
     */
    async waitForIdle(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (runningOperations.size > 0) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return "timeout";
        const outcome = await settleOrTimeout(Promise.allSettled([...runningOperations]), remainingMs);
        if (outcome === "timeout") return "timeout";
        // Let the settle handlers remove the finished operations before checking again.
        await Promise.resolve();
      }
      return "idle";
    },
  };
}

async function settleOrTimeout(settlingPromise, timeoutMs) {
  let timeoutHandle;
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([settlingPromise.then(() => "settled"), timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
