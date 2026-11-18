/**
 * Parameter schemas and helpers shared by the web-browser operations.
 */
import { invalidInput } from "../lib/errors.mjs";
import { MAX_SELECTOR_LENGTH } from "../lib/field-specs.mjs";

export const URL_PROPERTY = {
  type: "string",
  description: "Page to open: an http:// or https:// URL on a public host (loopback, private and cloud-metadata addresses are refused)",
};

export const WAIT_PROPERTIES = {
  wait_until: {
    type: "string",
    enum: ["load", "domcontentloaded", "networkidle"],
    default: "load",
    description: "When the page counts as loaded: `load` (default), `domcontentloaded` (faster), or `networkidle` (no requests for 500 ms; for pages that render with JavaScript)",
  },
  wait_for_selector: {
    type: "string",
    description: "Optional CSS selector to wait for after loading, e.g. \"article h1\" (for content rendered later by JavaScript)",
  },
  timeout_seconds: {
    type: "integer",
    minimum: 5,
    maximum: 60,
    default: 30,
    description: "Time allowed for loading and waiting, in seconds",
  },
};

/**
 * Builds the page-load request from validated arguments.
 *
 * @param args - Validated operation arguments (object)
 * @param purpose - "text" or "screenshot" (string)
 * @param viewport - `{width, height}` (object, optional)
 * @returns Request for browsePage (object)
 * @throws PluginError kind `invalid_input` - When `wait_for_selector` is too long
 */
export function buildLoadRequest(args, purpose, viewport) {
  const waitForSelector = args.wait_for_selector?.trim() || null;
  if (waitForSelector && waitForSelector.length > MAX_SELECTOR_LENGTH) {
    throw invalidInput(`\`wait_for_selector\` must be at most ${MAX_SELECTOR_LENGTH} characters`);
  }
  return {
    url: args.url,
    waitUntil: args.wait_until,
    waitForSelector,
    timeoutMs: args.timeout_seconds * 1000,
    purpose,
    viewport,
  };
}

/**
 * Common result fields describing the loaded page.
 *
 * @param requestedUrl - URL the caller asked for (string)
 * @param loadedPage - From browsePage (object)
 * @param blockedRequests - From browsePage (object[])
 * @returns `{url, final_url, status, content_type, blocked_requests, warnings}` (object)
 */
export function describePage(requestedUrl, loadedPage, blockedRequests) {
  return {
    url: requestedUrl,
    final_url: loadedPage.finalUrl,
    status: loadedPage.status,
    content_type: loadedPage.contentType,
    blocked_requests: blockedRequests,
    warnings: loadedPage.warnings,
  };
}
