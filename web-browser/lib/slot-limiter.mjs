/**
 * A counting semaphore: at most `maxSlots` pages are open at once; later
 * operations wait in FIFO order (and stop waiting when their signal aborts).
 */

/**
 * Creates a slot limiter.
 *
 * @param maxSlots - Concurrent holders allowed (number)
 * @returns `{acquire(signal) => Promise<release()>, activeCount(), waitingCount()}` (object)
 *
 * @example
 * const limiter = createSlotLimiter(2);
 * const release = await limiter.acquire(signal);
 * try { await work(); } finally { release(); }
 */
export function createSlotLimiter(maxSlots) {
  let activeCount = 0;
  const waiters = [];
  const grant = () => {
    activeCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeCount -= 1;
      waiters.shift()?.();
    };
  };
  return {
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
      if (activeCount < maxSlots) return Promise.resolve(grant());
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          waiters.splice(waiters.indexOf(wake), 1);
          reject(signal.reason ?? new Error("aborted"));
        };
        const wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(grant());
        };
        waiters.push(wake);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    activeCount: () => activeCount,
    waitingCount: () => waiters.length,
  };
}
