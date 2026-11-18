/**
 * Test doubles: a fake Playwright browser/context/page, a fake DNS resolver,
 * a fake egress proxy and a runner wired to them. Nothing here opens a
 * browser; only the proxy/robots tests use real sockets, on 127.0.0.1.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

/** Public test addresses (documentation-free real ranges) and internal ones, by host name. */
export const FAKE_DNS = {
  "example.com": ["93.184.215.14"],
  "www.example.com": ["93.184.215.14"],
  "dual.example": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
  "internal.example": ["10.1.2.3"],
  "mixed.example": ["93.184.215.14", "192.168.1.10"],
  "metadata.example": ["169.254.169.254"],
  "mapped.example": ["::ffff:127.0.0.1"],
};

/**
 * Fake resolver over FAKE_DNS; unknown names fail like getaddrinfo ENOTFOUND.
 *
 * @returns `async (hostname) => string[]` with a `calls` array (function)
 */
export function createFakeResolver(table = FAKE_DNS) {
  const resolver = async (hostname) => {
    resolver.calls.push(hostname);
    if (table[hostname]) return table[hostname];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
  };
  resolver.calls = [];
  return resolver;
}

/** Builds a snapshot element node. */
export function element(tag, attrs = {}, ...children) {
  return { tag, attrs, children: children.flat() };
}

/** A typical article page snapshot. */
export function buildArticleSnapshot() {
  return {
    root: element(
      "body",
      {},
      element("header", {}, element("nav", {}, element("a", { href: "https://example.com/" }, "Home"))),
      element(
        "main",
        {},
        element("h1", {}, "Hello world"),
        element("p", {}, "Some ", element("a", { href: "https://example.com/more" }, "linked"), " text that is long enough to count as the main content of this page, really."),
      ),
      element("footer", {}, "Footer text"),
    ),
    metadata: { title: "Hello", description: "Desc", lang: "en", canonical_url: null, content_type: "text/html" },
    truncated: false,
  };
}

/**
 * Fake page: `goto` lands on the URL (or `options.finalUrl`) and emits a main-frame response.
 *
 * In-page readers run through a fake CDP session (see createFakeCdpSession); `beforeRead(page)`
 * runs before each one and may throw, e.g. to simulate a navigation that destroys the page.
 *
 * @param options - `{snapshot, extractResults, pageHeight, status, headers, gotoError, failAfterCommit, waitError, finalUrl, gotoGate, beforeRead}` (object)
 */
export function createFakePage(options = {}) {
  const listeners = new Map();
  const page = {
    currentUrl: "about:blank",
    closed: false,
    calls: [],
    on: (eventName, listener) => listeners.set(eventName, [...(listeners.get(eventName) ?? []), listener]),
    emit: (eventName, payload) => (listeners.get(eventName) ?? []).forEach((listener) => listener(payload)),
    url: () => page.currentUrl,
    async goto(url, gotoOptions) {
      page.calls.push(["goto", url, gotoOptions]);
      await options.gotoGate;
      if (options.gotoError && !options.failAfterCommit) throw options.gotoError;
      page.currentUrl = options.finalUrl ?? url;
      page.emit("response", createFakeResponse(options.status ?? 200, options.headers));
      if (options.gotoError) throw options.gotoError;
      return null;
    },
    context: () => page.fakeContext,
    async runPageFunction(functionName, argument) {
      page.calls.push(["evaluate", functionName]);
      await options.beforeRead?.(page);
      if (functionName === "snapshotDocumentInPage") return options.snapshot ?? buildArticleSnapshot();
      if (functionName === "extractFieldsInPage") return options.extractResults?.(argument) ?? {};
      if (functionName === "measurePageHeightInPage") return options.pageHeight ?? 1200;
      if (functionName === "readTitleInPage") return options.snapshot?.metadata?.title ?? "Hello";
      throw new Error(`Unexpected page function ${functionName}`);
    },
    async waitForSelector(selector, waitOptions) {
      page.calls.push(["waitForSelector", selector, waitOptions]);
      if (options.waitError) throw options.waitError;
    },
    async screenshot(screenshotOptions) {
      page.calls.push(["screenshot", screenshotOptions]);
      return Buffer.from("PNGDATA");
    },
    async close() {
      page.closed = true;
    },
  };
  return page;
}

function createFakeResponse(status, headers = { "content-type": "text/html; charset=utf-8" }) {
  const request = { isNavigationRequest: () => true, frame: () => ({ parentFrame: () => null }) };
  return { request: () => request, status: () => status, headers: () => headers };
}

/**
 * Fake `launchBrowser` recording launches, contexts and their options.
 *
 * @param options - `{createPage, launchError}` (object)
 */
export function createFakeLauncher({ createPage = () => createFakePage(), launchError } = {}) {
  const launcher = async () => {
    launcher.launchCount += 1;
    if (launchError) throw launchError;
    const browser = createFakeBrowser(createPage, launcher);
    launcher.browsers.push(browser);
    return browser;
  };
  Object.assign(launcher, { launchCount: 0, browsers: [], contexts: [] });
  return launcher;
}

function createFakeBrowser(createPage, launcher) {
  const listeners = new Map();
  const browser = {
    closed: false,
    version: () => "131.0.6778.33",
    isConnected: () => !browser.closed,
    on: (eventName, listener) => listeners.set(eventName, listener),
    disconnect: () => {
      browser.closed = true;
      listeners.get("disconnected")?.();
    },
    async newContext(contextOptions) {
      const context = createFakeContext(contextOptions, createPage);
      launcher.contexts.push(context);
      return context;
    },
    async close() {
      browser.closed = true;
    },
  };
  return browser;
}

function createFakeContext(contextOptions, createPage) {
  const context = {
    options: contextOptions,
    closed: false,
    routes: [],
    initScripts: [],
    pages: [],
    async route(pattern, handler) {
      context.routes.push({ pattern, handler });
    },
    async addInitScript(script, argument) {
      context.initScripts.push({ script, argument });
    },
    async newCDPSession(page) {
      return createFakeCdpSession({ evaluateResult: (params) => evaluateWithFakePage(page, params) }).session;
    },
    async newPage() {
      const page = createPage();
      page.fakeContext = context;
      context.pages.push(page);
      return page;
    },
    async close() {
      context.closed = true;
      context.pages.forEach((page) => {
        page.closed = true;
      });
    },
  };
  return context;
}

// Finds which fixed page function an isolated-world expression calls and runs the fake page's answer.
async function evaluateWithFakePage(page, { expression }) {
  const functionName = /^\(function (\w+)\(/.exec(expression)?.[1];
  const argumentJson = expression.slice(expression.lastIndexOf(")(\n") + 3, -2);
  try {
    return { result: { value: await page.runPageFunction(functionName, argumentJson ? JSON.parse(argumentJson) : undefined) } };
  } catch (pageError) {
    return Promise.reject(pageError);
  }
}

/**
 * Fake CDP session for isolated-world reads: answers Page.getFrameTree and
 * Page.createIsolatedWorld, and Runtime.evaluate with `evaluateResult(params)`.
 *
 * @param options - `{evaluateResult}` (object)
 * @returns `{session, page, sent, detached}`; `page.context().newCDPSession()` returns `session` (object)
 */
export function createFakeCdpSession({ evaluateResult }) {
  const fake = { sent: [], detached: false };
  fake.session = {
    async send(method, params) {
      fake.sent.push([method, params]);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 77 };
      if (method === "Runtime.evaluate") return evaluateResult(params);
      throw new Error(`Unexpected CDP method ${method}`);
    },
    async detach() {
      fake.detached = true;
    },
  };
  fake.page = { context: () => ({ newCDPSession: async () => fake.session }) };
  return fake;
}

/** Fake egress proxy factory; `stats` can be overridden per test. */
export function createFakeProxyFactory(statsOverrides = {}) {
  const factory = async (proxyOptions) => {
    factory.starts.push(proxyOptions);
    const proxy = {
      url: "http://127.0.0.1:1",
      credentials: { username: "op-user", password: "op-secret" },
      closed: false,
      stats: () => ({ bytesReceived: 0, budgetExceeded: false, blocked: [], blockedHosts: new Set(), ...statsOverrides }),
      close: async () => {
        proxy.closed = true;
      },
    };
    factory.proxies.push(proxy);
    return proxy;
  };
  Object.assign(factory, { starts: [], proxies: [] });
  return factory;
}

/** Fake timers: nothing fires until `fireAll()`. */
export function createFakeTimers() {
  let scheduledTimers = [];
  return {
    setTimeout: (callback, delayMs) => {
      const timer = { callback, delayMs };
      scheduledTimers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      scheduledTimers = scheduledTimers.filter((scheduled) => scheduled !== timer);
    },
    pending: () => [...scheduledTimers],
    async fireAll() {
      const dueTimers = scheduledTimers;
      scheduledTimers = [];
      await Promise.all(dueTimers.map((timer) => timer.callback()));
    },
  };
}

/**
 * Creates a runner with a fake browser, fake DNS, fake proxy and fake robots.txt.
 *
 * @param options - `{pageOptions, robotsText, robotsOutcome, environment, proxyStats}` (object)
 * @returns `{runOperation, launcher, proxyFactory, resolver, robotsFetches, definition, screenshotDirectory, cleanup}`
 */
export async function createTestRunner({ pageOptions, robotsText = "", robotsOutcome, environment = {}, proxyStats } = {}) {
  const screenshotDirectory = await mkdtemp(join(tmpdir(), "web-browser-test-"));
  const launcher = createFakeLauncher({ createPage: () => createFakePage(pageOptions) });
  const proxyFactory = createFakeProxyFactory(proxyStats);
  const resolver = createFakeResolver();
  const robotsFetches = [];
  const fetchRobotsFile = async (robotsUrl) => {
    robotsFetches.push(robotsUrl);
    return robotsOutcome ?? { status: "ok", text: robotsText };
  };
  const definition = createPluginDefinition({ launchBrowser: launcher, resolveHostAddresses: resolver, fetchRobotsFile, startProxy: proxyFactory, timers: createFakeTimers() });
  const runner = createOperationRunner(definition, { WEB_BROWSER_SCREENSHOT_DIR: screenshotDirectory, ...environment });
  return {
    runOperation: (operationName, args, source = "tool") => runner(operationName, args, { source }),
    launcher,
    proxyFactory,
    resolver,
    robotsFetches,
    definition,
    screenshotDirectory,
    cleanup: () => rm(screenshotDirectory, { recursive: true, force: true }),
  };
}
