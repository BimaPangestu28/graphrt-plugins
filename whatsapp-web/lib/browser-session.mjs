/**
 * One long-lived Chromium persistent context per plugin process.
 *
 * Lifecycle:
 * - Started lazily by the first operation (headless), on the profile directory.
 * - Every operation runs through a serial queue, on the context's single page.
 * - Closed after `idleTimeoutMs` without operations, on `close()` (plugin
 *   shutdown) and when an operation asks for `closeAfter` (login).
 * - Relaunched when an operation needs the other mode (login is headed).
 * - Cancelling an operation closes the page, which makes pending Playwright
 *   calls reject at once; the next operation opens a fresh page. A cancel that
 *   arrives while the browser is still starting stops the operation before it runs.
 * - A crashed or closed tab is replaced by a fresh page on the next operation.
 */
import { mkdir } from "node:fs/promises";
import { cancelled } from "./errors.mjs";
import { buildDesktopUserAgent, classifyLaunchError } from "./parse.mjs";
import { acquireProfileLock } from "./profile-lock.mjs";
import { createTaskQueue } from "./task-queue.mjs";

const DEFAULT_ACTION_TIMEOUT_MS = 30000;
const CONTEXT_CLOSE_TIMEOUT_MS = 10000;
const VIEWPORT = { width: 1280, height: 900 };

/**
 * Creates a browser session.
 *
 * @param options - Session options (object)
 * @param options.profileDirectory - Chromium user data directory (string)
 * @param options.idleTimeoutMs - Close the browser after this long without operations (number)
 * @param options.launchPersistentContext - `(profileDirectory, launchOptions) => Promise<BrowserContext>`,
 *   defaults to Playwright's chromium (function, optional)
 * @param options.timers - `{setTimeout, clearTimeout}`, injectable for tests (object, optional)
 * @returns `{run(task, {headed, closeAfter, signal}), close(), isOpen()}` (object)
 */
export function createBrowserSession({ profileDirectory, idleTimeoutMs, launchPersistentContext = launchWithPlaywright, timers = globalThis }) {
  const queue = createTaskQueue();
  const state = { context: null, isHeaded: false, idleTimer: null, releaseLock: async () => {} };
  const crashedPages = new WeakSet();

  const closeContext = async (reason) => {
    const openContext = state.context;
    if (!openContext) return;
    state.context = null;
    console.error(`[whatsapp-web] closing browser (${reason})`);
    await closeWithTimeout(openContext);
    await state.releaseLock();
  };

  const scheduleIdleClose = () => {
    cancelIdleClose(state, timers);
    if (!state.context) return;
    state.idleTimer = timers.setTimeout(() => queue.enqueue(() => closeContext("idle")), idleTimeoutMs);
    state.idleTimer?.unref?.();
  };

  const openPage = async (headed) => {
    if (state.context && state.isHeaded !== headed) await closeContext(headed ? "switching to a visible window" : "switching to headless");
    if (!state.context) {
      const { context, releaseLock } = await launchLockedContext(profileDirectory, headed, launchPersistentContext);
      Object.assign(state, { context, isHeaded: headed, releaseLock });
      watchContextClose(state, context, releaseLock);
    }
    const page = await pickUsablePage(state.context, crashedPages);
    page.setDefaultTimeout?.(DEFAULT_ACTION_TIMEOUT_MS);
    return page;
  };

  const runTask = async (task, { headed = false, closeAfter = false, signal } = {}) => {
    if (signal?.aborted) throw cancelled();
    cancelIdleClose(state, timers);
    try {
      const page = await openPage(headed);
      // The run may have been cancelled while the browser was starting; the abort event has already fired.
      if (signal?.aborted) throw cancelled();
      return await runOnPage(page, task, signal);
    } finally {
      if (closeAfter) await closeContext("operation finished");
      scheduleIdleClose();
    }
  };

  return {
    run: (task, runOptions) => queue.enqueue(() => runTask(task, runOptions)),
    /** Closes the browser now, without waiting for queued operations (used on shutdown). */
    async close() {
      cancelIdleClose(state, timers);
      await closeContext("plugin shutdown");
    },
    isOpen: () => state.context !== null,
  };
}

// Reuses the first live page; a crashed ("Aw, Snap!") or closed tab is closed and replaced by a new one.
async function pickUsablePage(context, crashedPages) {
  for (const page of context.pages()) {
    if (page.isClosed?.()) continue;
    if (!crashedPages.has(page)) return watchPageCrash(page, crashedPages);
    console.error("[whatsapp-web] the WhatsApp Web tab crashed; opening a new one");
    await page.close().catch((closeError) => console.error(`[whatsapp-web] closing the crashed tab failed: ${closeError.message}`));
  }
  return watchPageCrash(await context.newPage(), crashedPages);
}

const watchedPages = new WeakSet();

function watchPageCrash(page, crashedPages) {
  if (!watchedPages.has(page)) {
    watchedPages.add(page);
    page.on?.("crash", () => crashedPages.add(page));
  }
  return page;
}

async function runOnPage(page, task, signal) {
  const closePage = () => page.close().catch((closeError) => console.error(`[whatsapp-web] page close on cancel failed: ${closeError.message}`));
  signal?.addEventListener("abort", closePage, { once: true });
  try {
    return await task(page);
  } catch (taskError) {
    throw signal?.aborted ? cancelled() : taskError;
  } finally {
    signal?.removeEventListener("abort", closePage);
  }
}

async function launchLockedContext(profileDirectory, headed, launchPersistentContext) {
  await mkdir(profileDirectory, { recursive: true });
  const releaseLock = await acquireProfileLock(profileDirectory);
  try {
    return { context: await launchContext(profileDirectory, headed, launchPersistentContext), releaseLock };
  } catch (launchError) {
    await releaseLock();
    throw launchError;
  }
}

async function launchContext(profileDirectory, headed, launchPersistentContext) {
  try {
    console.error(`[whatsapp-web] starting ${headed ? "visible" : "headless"} browser on ${profileDirectory}`);
    return await launchPersistentContext(profileDirectory, {
      headless: !headed,
      viewport: VIEWPORT,
      // The plugin closes the context itself (plugin.mjs) so the profile is flushed cleanly.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  } catch (launchError) {
    throw classifyLaunchError(launchError);
  }
}

// A crashed browser or a window closed by the user must not leave a dead context (or a held lock) behind.
function watchContextClose(state, context, releaseLock) {
  context.on?.("close", () => {
    if (state.context === context) state.context = null;
    releaseLock().catch((releaseError) => console.error(`[whatsapp-web] releasing the profile lock failed: ${releaseError.message}`));
  });
}

function cancelIdleClose(state, timers) {
  if (state.idleTimer) timers.clearTimeout(state.idleTimer);
  state.idleTimer = null;
}

async function closeWithTimeout(context) {
  let timeoutHandle;
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), CONTEXT_CLOSE_TIMEOUT_MS);
  });
  const outcome = await Promise.race([context.close().then(() => "closed", (closeError) => closeError), timeout]);
  clearTimeout(timeoutHandle);
  if (outcome !== "closed") console.error(`[whatsapp-web] browser close did not finish cleanly: ${outcome?.message ?? outcome}`);
}

let desktopUserAgentPromise = null;

async function launchWithPlaywright(profileDirectory, launchOptions) {
  // Imported lazily so tests and `npm run sync` work without node_modules.
  const { chromium } = await import("playwright");
  desktopUserAgentPromise ??= detectDesktopUserAgent(chromium).catch((detectError) => {
    desktopUserAgentPromise = null;
    throw detectError;
  });
  const userAgent = await desktopUserAgentPromise;
  return chromium.launchPersistentContext(profileDirectory, { ...launchOptions, userAgent });
}

// Same UA in both modes, so the linked device looks the same headed (login) and headless.
async function detectDesktopUserAgent(chromium) {
  const probeBrowser = await chromium.launch({ headless: true });
  try {
    return buildDesktopUserAgent(probeBrowser.version(), process.platform);
  } finally {
    await probeBrowser.close();
  }
}
