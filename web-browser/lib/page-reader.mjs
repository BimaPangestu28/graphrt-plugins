/**
 * Runs the plugin's fixed in-page readers (page-snapshot.mjs) in a fresh
 * ISOLATED WORLD of the main frame, through a CDP session.
 *
 * Why not `page.evaluate`: that runs in the page's own JavaScript world, where
 * the page may have replaced `Math.max`, `String.prototype.slice`,
 * `Node.prototype.nodeValue`, `getComputedStyle` and so on, which disables the
 * readers' caps or hangs them. An isolated world shares the DOM but has its
 * own, untouched built-ins and DOM wrappers.
 *
 * Every read is bounded in time: Chromium terminates the reader after
 * `timeoutMs` and Node stops waiting at the same moment (a page that spins its
 * main thread never lets the reader start at all). The caller's context is
 * then closed, which frees the slot.
 */
import { browserError, timeoutError } from "./errors.mjs";

export const READ_TIMEOUT_MS = 8000;
const ISOLATED_WORLD_NAME = "graphrt-web-browser-reader";

/**
 * Evaluates a fixed page function with one JSON argument in an isolated world.
 *
 * @param page - Playwright Page (object)
 * @param pageFunction - A self-contained function from page-snapshot.mjs (function)
 * @param argument - JSON-serialisable argument (unknown)
 * @param options - `{timeoutMs}` (object, optional)
 * @returns The function's return value, as JSON (Promise<unknown>)
 * @throws PluginError kind `timeout` - The page did not answer within `timeoutMs`
 * @throws PluginError kind `browser_error` - The function threw inside the page
 *
 * @example
 * const snapshot = await evaluateInIsolatedWorld(page, snapshotDocumentInPage, SNAPSHOT_LIMITS);
 */
export async function evaluateInIsolatedWorld(page, pageFunction, argument, { timeoutMs = READ_TIMEOUT_MS } = {}) {
  const session = await page.context().newCDPSession(page);
  let timeoutHandle;
  const deadline = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(timeoutError(`Reading the page took longer than ${timeoutMs / 1000} s; the page may be busy`)), timeoutMs);
  });
  try {
    return await Promise.race([evaluateWithSession(session, pageFunction, argument, timeoutMs), deadline]);
  } finally {
    clearTimeout(timeoutHandle);
    session.detach().catch(() => {});
  }
}

async function evaluateWithSession(session, pageFunction, argument, timeoutMs) {
  const { frameTree } = await session.send("Page.getFrameTree");
  const { executionContextId } = await session.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: ISOLATED_WORLD_NAME,
    grantUniveralAccess: false,
  });
  const evaluation = await session.send("Runtime.evaluate", {
    expression: buildCallExpression(pageFunction, argument),
    contextId: executionContextId,
    returnByValue: true,
    awaitPromise: false,
    timeout: timeoutMs,
  });
  if (evaluation.exceptionDetails) {
    const details = evaluation.exceptionDetails;
    const description = String(details.exception?.description ?? details.text ?? "the page function threw");
    if (/terminated/i.test(description)) throw timeoutError(`Reading the page took longer than ${timeoutMs / 1000} s; the page is too large or busy`);
    throw browserError("read page", description);
  }
  return evaluation.result?.value;
}

function buildCallExpression(pageFunction, argument) {
  const argumentJson = argument === undefined ? "" : JSON.stringify(argument);
  return `(${pageFunction.toString()})(\n${argumentJson}\n)`;
}
