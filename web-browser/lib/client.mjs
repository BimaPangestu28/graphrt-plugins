/**
 * Builds the per-process "client" handed to operations: settings, the shared
 * browser session, the host guard, the robots.txt checker, the egress proxy
 * factory and the screenshot writer. The shared runner calls `createClient`
 * for every operation, so the client is cached for the life of the process.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHostGuard } from "./address-policy.mjs";
import { createBrowserSession } from "./browser-session.mjs";
import { startEgressProxy } from "./egress-proxy.mjs";
import { createRobotsChecker, ROBOTS_PRODUCT_TOKEN } from "./robots-checker.mjs";
import { resolveSettings } from "./settings.mjs";

export const PLUGIN_VERSION = "0.1.0";
export const PROJECT_URL = "https://github.com/BimaPangestu28/graphrt-plugins";
const SCREENSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Names writeScreenshotFile generates: <ISO timestamp>-<host>-<8 hex>.png. Other files are never touched.
const GENERATED_SCREENSHOT_NAME = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-z0-9._-]+-[0-9a-f]{8}\.png$/i;
const PLATFORM_TOKENS = { darwin: "Macintosh; Intel Mac OS X 10_15_7", win32: "Windows NT 10.0; Win64; x64" };

/**
 * Creates a cached client factory with injectable side effects.
 *
 * @param dependencies - Overrides for tests (object, all optional)
 * @param dependencies.launchBrowser - `async () => Browser` (function)
 * @param dependencies.resolveHostAddresses - `async (hostname) => string[]` (function)
 * @param dependencies.allowedTestHosts - Hosts exempt from the public-host check. TESTS ONLY (string[])
 * @param dependencies.fetchRobotsFile - Replaces the robots.txt fetcher (function)
 * @param dependencies.startProxy - Replaces startEgressProxy (function)
 * @param dependencies.timers - `{setTimeout, clearTimeout}` for the idle shutdown (object)
 * @returns `{createClient({environment}), closeAllClients()}` (object)
 */
export function createClientFactory(dependencies = {}) {
  const clientsBySettings = new Map();
  return {
    createClient({ environment }) {
      const settings = resolveSettings(environment);
      const settingsKey = JSON.stringify(settings);
      if (!clientsBySettings.has(settingsKey)) clientsBySettings.set(settingsKey, buildClient(settings, dependencies));
      return clientsBySettings.get(settingsKey);
    },
    /** Closes every browser this process opened (plugin shutdown). */
    async closeAllClients() {
      await Promise.all([...clientsBySettings.values()].map((client) => client.session.close()));
    },
  };
}

function buildClient(settings, dependencies) {
  const hostGuard = createHostGuard({ resolveHostAddresses: dependencies.resolveHostAddresses, allowedTestHosts: dependencies.allowedTestHosts });
  const session = createBrowserSession({
    idleTimeoutMs: settings.idleTimeoutMs,
    maxConcurrentPages: settings.maxConcurrentPages,
    launchBrowser: dependencies.launchBrowser,
    timers: dependencies.timers,
  });
  const robotsUserAgent = settings.userAgentOverride ?? `${ROBOTS_PRODUCT_TOKEN}/${PLUGIN_VERSION} (+${PROJECT_URL})`;
  const robotsChecker = settings.respectRobots
    ? createRobotsChecker({ hostGuard, userAgent: robotsUserAgent, fetchRobotsFile: dependencies.fetchRobotsFile })
    : null;
  return {
    settings,
    session,
    hostGuard,
    robotsChecker,
    startProxy: dependencies.startProxy ?? startEgressProxy,
    resolveUserAgent: async () => settings.userAgentOverride ?? buildBrowserUserAgent(await session.browserVersion(), process.platform),
    writeScreenshot: (pngBuffer, pageUrl) => writeScreenshotFile(settings.screenshotDirectory, pngBuffer, pageUrl),
  };
}

/**
 * Builds the browser's User-Agent: a normal Chrome UA (sites serve their usual
 * page) that also names this plugin, its robots.txt token and where to read about it.
 *
 * @param browserVersion - Chromium version, e.g. "131.0.6778.33" (string)
 * @param platform - `process.platform` (string)
 * @returns User-Agent header value (string)
 */
export function buildBrowserUserAgent(browserVersion, platform) {
  const platformToken = PLATFORM_TOKENS[platform] ?? "X11; Linux x86_64";
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion} Safari/537.36 ${ROBOTS_PRODUCT_TOKEN}/${PLUGIN_VERSION} (+${PROJECT_URL})`;
}

/**
 * Writes a PNG into the screenshot directory under a generated name (callers never choose paths),
 * after deleting this plugin's screenshots older than 24 hours so the directory cannot grow forever.
 *
 * @param screenshotDirectory - WEB_BROWSER_SCREENSHOT_DIR (string)
 * @param pngBuffer - Image bytes (Buffer)
 * @param pageUrl - Page the screenshot shows, used in the file name (string)
 * @returns Absolute file path (Promise<string>)
 */
export async function writeScreenshotFile(screenshotDirectory, pngBuffer, pageUrl) {
  await mkdir(screenshotDirectory, { recursive: true, mode: 0o700 });
  await deleteOldScreenshots(screenshotDirectory, Date.now() - SCREENSHOT_MAX_AGE_MS);
  const hostSlug = (new URL(pageUrl).hostname.replace(/[^a-z0-9.-]/gi, "_") || "page").slice(0, 60);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(screenshotDirectory, `${timestamp}-${hostSlug}-${randomBytes(4).toString("hex")}.png`);
  await writeFile(filePath, pngBuffer, { mode: 0o600, flag: "wx" });
  return filePath;
}

/**
 * Deletes generated screenshots last modified before `cutoffTime`. Failures are logged, never thrown:
 * cleanup must not fail the screenshot being taken.
 *
 * @param screenshotDirectory - Directory to clean (string)
 * @param cutoffTime - Epoch milliseconds (number)
 * @returns Number of files deleted (Promise<number>)
 */
export async function deleteOldScreenshots(screenshotDirectory, cutoffTime) {
  let deletedCount = 0;
  try {
    for (const fileName of await readdir(screenshotDirectory)) {
      if (!GENERATED_SCREENSHOT_NAME.test(fileName)) continue;
      const filePath = join(screenshotDirectory, fileName);
      const fileStats = await stat(filePath).catch(() => null);
      if (!fileStats?.isFile() || fileStats.mtimeMs >= cutoffTime) continue;
      await unlink(filePath);
      deletedCount += 1;
    }
  } catch (cleanupError) {
    console.error(`[web-browser] cleaning old screenshots failed: ${cleanupError?.message ?? cleanupError}`);
  }
  return deletedCount;
}
