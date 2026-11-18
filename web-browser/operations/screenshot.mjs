/**
 * screenshot: a PNG of a public page, written into WEB_BROWSER_SCREENSHOT_DIR
 * under a generated file name (callers never choose paths).
 */
import { browsePage } from "../lib/page-loader.mjs";
import { evaluateInIsolatedWorld } from "../lib/page-reader.mjs";
import { measurePageHeightInPage, readTitleInPage } from "../lib/page-snapshot.mjs";
import { sanitizePageHeight, sanitizeTitle } from "../lib/snapshot-limits.mjs";
import { buildLoadRequest, describePage, URL_PROPERTY, WAIT_PROPERTIES } from "./common.mjs";

const SCREENSHOT_TIMEOUT_MS = 20000;

const screenshotOperation = {
  name: "screenshot",
  title: "Screenshot web page",
  description:
    "Open a public web page and save a PNG screenshot (viewport, or full page up to max_height pixels) in WEB_BROWSER_SCREENSHOT_DIR; returns the file path.",
  parameters: {
    type: "object",
    properties: {
      url: URL_PROPERTY,
      full_page: { type: "boolean", default: false, description: "Capture the whole page height (up to max_height) instead of the viewport" },
      viewport_width: { type: "integer", minimum: 320, maximum: 1920, default: 1280, description: "Viewport width in CSS pixels" },
      viewport_height: { type: "integer", minimum: 240, maximum: 2000, default: 800, description: "Viewport height in CSS pixels" },
      max_height: { type: "integer", minimum: 240, maximum: 16000, default: 8000, description: "Full-page screenshots are cut at this height" },
      ...WAIT_PROPERTIES,
    },
    required: ["url"],
  },
  run: async ({ client, args, signal }) => {
    const viewport = { width: args.viewport_width, height: args.viewport_height };
    const readPage = async (page, loadedPage) => {
      const pageHeight = sanitizePageHeight(await evaluateInIsolatedWorld(page, measurePageHeightInPage));
      const capture = planCapture({ fullPage: args.full_page, viewport, pageHeight, maxHeight: args.max_height });
      const pngBuffer = await page.screenshot({ type: "png", timeout: SCREENSHOT_TIMEOUT_MS, ...capture.options });
      const filePath = await client.writeScreenshot(pngBuffer, loadedPage.finalUrl);
      return { path: filePath, bytes: pngBuffer.length, width: viewport.width, height: capture.height, page_height: pageHeight, height_truncated: capture.truncated, title: sanitizeTitle(await evaluateInIsolatedWorld(page, readTitleInPage)) };
    };
    const { result, loadedPage, blockedRequests } = await browsePage(client, buildLoadRequest(args, "screenshot", viewport), readPage, signal);
    return { data: { ...describePage(args.url, loadedPage, blockedRequests), ...result } };
  },
};

/**
 * Chooses Playwright screenshot options (pure).
 *
 * @param plan - `{fullPage, viewport: {width, height}, pageHeight, maxHeight}` (object)
 * @returns `{options, height, truncated}` (object)
 *
 * @example
 * planCapture({ fullPage: true, viewport: { width: 1280, height: 800 }, pageHeight: 20000, maxHeight: 8000 });
 * // { options: { fullPage: true, clip: { x: 0, y: 0, width: 1280, height: 8000 } }, height: 8000, truncated: true }
 */
export function planCapture({ fullPage, viewport, pageHeight, maxHeight }) {
  if (!fullPage) return { options: {}, height: viewport.height, truncated: false };
  const captureHeight = Math.max(1, Math.min(Math.ceil(pageHeight) || viewport.height, maxHeight));
  return {
    options: { fullPage: true, clip: { x: 0, y: 0, width: viewport.width, height: captureHeight } },
    height: captureHeight,
    truncated: pageHeight > maxHeight,
  };
}

export const screenshotOperations = [screenshotOperation];
