/**
 * One long-lived headless Chromium per plugin process, with a FRESH browser
 * context for every operation (no cookies, storage or cache carried over).
 *
 * Lifecycle:
 * - Launched lazily by the first operation; concurrent first calls share one launch.
 * - At most `maxConcurrentPages` contexts are open at once (slot limiter).
 * - Closed after `idleTimeoutMs` without operations and on `close()` (shutdown).
 * - Cancelling an operation closes its context, which makes pending Playwright
 *   calls reject at once. A crashed/disconnected browser is relaunched next time.
 */
import { cancelled, classifyLaunchError, timeoutError } from "./errors.mjs";
import { createSlotLimiter } from "./slot-limiter.mjs";

const CLOSE_TIMEOUT_MS = 10000;
const LAUNCH_TIMEOUT_MS = 30000;
// Browser-wide lock on WebRTC UDP, which would otherwise go around the proxy to any address.
// Verified against Playwright's headless Chromium: with this switch a page's STUN requests and
// remote candidates send no UDP; the non-forced `--webrtc-ip-handling-policy` has no effect.
// The init script in page-hardening.mjs also removes the WebRTC APIs from every page.
export const CHROMIUM_ARGS = ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"];

/**
 * Creates a browser session.
 *
 * @param options - Session options (object)
 * @param options.idleTimeoutMs - Close the browser after this long without operations (number)
 * @param options.maxConcurrentPages - Contexts open at the same time (number)
 * @param options.launchBrowser - `async () => Browser`; Playwright Chromium by default (function, optional)
 * @param options.timers - `{setTimeout, clearTimeout}`, injectable for tests (object, optional)
 * @returns `{withContext(contextOptions, task, {signal}), browserVersion(), close(), isOpen()}` (object)
 */
export function createBrowserSession({ idleTimeoutMs, maxConcurrentPages, launchBrowser = launchWithPlaywright, timers = globalThis }) {
  const limiter = createSlotLimiter(maxConcurrentPages);
  const state = { browser: null, launchPromise: null, idleTimer: null };

  const ensureBrowser = async () => {
    if (state.browser && state.browser.isConnected?.() !== false) return state.browser;
    state.launchPromise ??= startBrowser(launchBrowser, state).finally(() => {
      state.launchPromise = null;
    });
    return state.launchPromise;
  };

  const scheduleIdleClose = () => {
    cancelIdleClose(state, timers);
    if (!state.browser || limiter.activeCount() > 0) return;
    state.idleTimer = timers.setTimeout(() => {
      if (limiter.activeCount() === 0) closeBrowser(state, "idle");
    }, idleTimeoutMs);
    state.idleTimer?.unref?.();
  };

  const withContext = async (contextOptions, task, { signal } = {}) => {
    const release = await limiter.acquire(signal).catch(() => {
      throw describeAbort(signal);
    });
    cancelIdleClose(state, timers);
    try {
      return await runInFreshContext({ ensureBrowser, contextOptions, task, signal });
    } finally {
      release();
      scheduleIdleClose();
    }
  };

  return {
    withContext,
    /** Chromium version of the running browser (launches it when needed). */
    browserVersion: async () => (await ensureBrowser()).version(),
    /** Closes the browser now (plugin shutdown); running contexts fail. */
    async close() {
      cancelIdleClose(state, timers);
      await closeBrowser(state, "plugin shutdown");
    },
    isOpen: () => state.browser !== null,
  };
}

async function runInFreshContext({ ensureBrowser, contextOptions, task, signal }) {
  if (signal?.aborted) throw describeAbort(signal);
  const launchWatch = createAbortWatch(signal);
  // A shared launch keeps going for the next caller; this caller just stops waiting.
  const browser = await Promise.race([ensureBrowser(), launchWatch.promise]).finally(launchWatch.dispose);
  const context = await browser.newContext(contextOptions);
  const abort = createAbortWatch(signal);
  const closeContext = () => closeWithTimeout(context, "context");
  signal?.addEventListener("abort", closeContext, { once: true });
  try {
    // The race returns at the deadline even if a Playwright call ignores the closed context.
    return await Promise.race([task(context), abort.promise]);
  } catch (taskError) {
    throw signal?.aborted ? describeAbort(signal) : taskError;
  } finally {
    abort.dispose();
    signal?.removeEventListener("abort", closeContext);
    await closeContext();
  }
}

function createAbortWatch(signal) {
  if (!signal) return { promise: new Promise(() => {}), dispose: () => {} };
  let onAbort;
  const promise = new Promise((resolve, reject) => {
    onAbort = () => reject(describeAbort(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  promise.catch(() => {});
  return { promise, dispose: () => signal.removeEventListener("abort", onAbort) };
}

/**
 * Turns an aborted signal into `timeout` (deadline signals) or `cancelled`.
 *
 * @param signal - The aborted signal (AbortSignal)
 * @returns PluginError kind `timeout` or `cancelled`
 */
export function describeAbort(signal) {
  if (signal?.reason?.name === "TimeoutError") return timeoutError("The page did not finish within the operation's time limit");
  return cancelled();
}

async function startBrowser(launchBrowser, state) {
  let browser;
  try {
    console.error("[web-browser] starting headless Chromium");
    browser = await launchBrowser();
  } catch (launchError) {
    throw classifyLaunchError(launchError);
  }
  state.browser = browser;
  browser.on?.("disconnected", () => {
    if (state.browser === browser) state.browser = null;
  });
  return browser;
}

async function closeBrowser(state, reason) {
  const openBrowser = state.browser;
  if (!openBrowser) return;
  state.browser = null;
  console.error(`[web-browser] closing browser (${reason})`);
  await closeWithTimeout(openBrowser, "browser");
}

function cancelIdleClose(state, timers) {
  if (state.idleTimer) timers.clearTimeout(state.idleTimer);
  state.idleTimer = null;
}

async function closeWithTimeout(closable, label) {
  let timeoutHandle;
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), CLOSE_TIMEOUT_MS);
  });
  const outcome = await Promise.race([closable.close().then(() => "closed", (closeError) => closeError), timeout]);
  clearTimeout(timeoutHandle);
  if (outcome !== "closed") console.error(`[web-browser] ${label} close did not finish cleanly: ${outcome?.message ?? outcome}`);
}

async function launchWithPlaywright() {
  // Imported lazily so tests and `npm run sync` work without node_modules.
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true, args: CHROMIUM_ARGS, timeout: LAUNCH_TIMEOUT_MS, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
}
