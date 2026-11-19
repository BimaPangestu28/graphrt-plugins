/**
 * web-browser plugin definition: read-only browsing of public web pages in a
 * headless Chromium (Playwright), with a fresh browser context per call.
 *
 * There is no API token: `resolveAccessToken` returns "local" and
 * `createClient` returns the cached client (browser session, host guard,
 * robots.txt checker, egress proxy factory). Security model: see README.md.
 */
import { createClientFactory } from "./lib/client.mjs";
import { createOperationTracker } from "./lib/operation-tracker.mjs";
import { readingOperations } from "./operations/reading.mjs";
import { screenshotOperations } from "./operations/screenshot.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - See createClientFactory (object, optional)
 * @returns Plugin definition plus `closeAllClients()` and `waitForRunningOperations(timeoutMs)` for shutdown (object)
 */
export function createPluginDefinition(dependencies = {}) {
  const { createClient, closeAllClients } = createClientFactory(dependencies);
  const operationTracker = createOperationTracker();
  const trackOperation = (operation) => ({ ...operation, run: (runContext) => operationTracker.track(() => operation.run(runContext)) });
  return {
    name: "web-browser",
    version: "0.2.1",
    description:
      "Read public web pages in a headless browser: readable text or markdown, links, CSS-selector extraction and screenshots. Public hosts only, robots.txt respected, no clicking or typing.",
    tokenEnv: "WEB_BROWSER_SCREENSHOT_DIR",
    extraEnv: ["WEB_BROWSER_RESPECT_ROBOTS", "WEB_BROWSER_IDLE_MINUTES", "WEB_BROWSER_MAX_PAGES", "WEB_BROWSER_MAX_DOWNLOAD_MB", "WEB_BROWSER_USER_AGENT"],
    // timeout_seconds (max 60) + 25 s for browser start and reading stays under the 90 s tool deadline.
    limits: { timeout_ms: 100000, max_concurrency: 4 },
    resolveAccessToken: () => "local",
    createClient,
    closeAllClients,
    waitForRunningOperations: (timeoutMs) => operationTracker.waitForIdle(timeoutMs),
    operations: [...readingOperations, ...screenshotOperations].map(trackOperation),
  };
}

export const pluginDefinition = createPluginDefinition();
