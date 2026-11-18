/**
 * Test doubles: a fake Playwright launcher/context/page, fake timers, a fake
 * WhatsApp driver, and a runner wired to them. Nothing here opens a browser
 * or touches the network.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

/**
 * Fake Playwright page. `evaluate(probe, argument)` answers from `probeResponses`,
 * a Map from probe function to a function `(argument, callIndex) => result`.
 */
export function createFakePage({ url = "about:blank", probeResponses = new Map() } = {}) {
  const page = {
    currentUrl: url,
    closed: false,
    actions: [],
    probeCalls: new Map(),
    closeListeners: [],
    eventListeners: new Map(),
    url: () => page.currentUrl,
    isClosed: () => page.closed,
    on: (eventName, listener) => page.eventListeners.set(eventName, [...(page.eventListeners.get(eventName) ?? []), listener]),
    emit: (eventName) => (page.eventListeners.get(eventName) ?? []).forEach((listener) => listener()),
    async goto(targetUrl) {
      page.actions.push(["goto", targetUrl]);
      page.currentUrl = targetUrl;
    },
    async evaluate(probe, argument) {
      const callIndex = page.probeCalls.get(probe) ?? 0;
      page.probeCalls.set(probe, callIndex + 1);
      const respond = probeResponses.get(probe);
      if (!respond) throw new Error(`No fake response for probe ${probe.name}`);
      return respond(argument, callIndex);
    },
    async waitForTimeout() {},
    setDefaultTimeout() {},
    keyboard: {
      press: async (key) => page.actions.push(["press", key]),
      insertText: async (text) => page.actions.push(["insertText", text]),
    },
    locator: (selector) => createFakeLocator(page, selector),
    onClose: (listener) => page.closeListeners.push(listener),
    async close() {
      page.closed = true;
      page.closeListeners.forEach((listener) => listener());
    },
  };
  return page;
}

function createFakeLocator(page, selector) {
  const locator = {
    first: () => locator,
    getByTitle: (title) => createFakeLocator(page, `${selector} >> title=${title}`),
    count: async () => 1,
    click: async () => page.actions.push(["click", selector]),
    fill: async (value) => page.actions.push(["fill", selector, value]),
    setInputFiles: async (filePath) => page.actions.push(["setInputFiles", selector, filePath]),
  };
  return locator;
}

/** Fake `launchPersistentContext` that records launches and hands out fake contexts. */
export function createFakeLauncher({ createPage = () => createFakePage() } = {}) {
  const launcher = async (profileDirectory, launchOptions) => {
    launcher.launches.push({ profileDirectory, launchOptions });
    const context = createFakeContext(createPage);
    launcher.contexts.push(context);
    return context;
  };
  launcher.launches = [];
  launcher.contexts = [];
  return launcher;
}

function createFakeContext(createPage) {
  const listeners = new Map();
  const context = {
    closed: false,
    pagesCreated: [],
    pages: () => context.pagesCreated.filter((page) => !page.closed),
    async newPage() {
      const page = createPage();
      context.pagesCreated.push(page);
      return page;
    },
    on: (eventName, listener) => listeners.set(eventName, [...(listeners.get(eventName) ?? []), listener]),
    emit: (eventName) => (listeners.get(eventName) ?? []).forEach((listener) => listener()),
    async close() {
      context.closed = true;
      context.emit("close");
    },
  };
  return context;
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

/** Fake driver: records calls and returns canned results (or runs `beforeSend` for sends). */
export function createFakeDriver(overrides = {}) {
  const calls = [];
  const record = (methodName, defaultResult) => async (options) => {
    calls.push([methodName, options]);
    if (overrides[methodName]) return overrides[methodName](options);
    return typeof defaultResult === "function" ? defaultResult(options) : defaultResult;
  };
  const sendResult = async (options) => ({
    chat: { chat_name: options.target.name ?? "Budi" },
    usage: await options.beforeSend(),
    message: { id: "3EB0NEW", status: "sent", time: "10:42, 18/11/2026" },
  });
  return {
    calls,
    getStatus: record("getStatus", "logged_in"),
    login: record("login", { status: "logged_in", already_logged_in: false }),
    listChats: record("listChats", []),
    searchChats: record("searchChats", []),
    readMessages: record("readMessages", { chat: { chat_name: "Budi" }, messages: [] }),
    sendText: record("sendText", sendResult),
    sendFile: record("sendFile", sendResult),
    close: record("close", undefined),
  };
}

/**
 * Creates a runner over a temporary profile directory with a fake driver.
 *
 * @returns `{runOperation, driver, profileDirectory, environment, cleanup}`
 */
export async function createTestRunner({ driverOverrides, environment = {}, fetchImpl, clock } = {}) {
  const profileDirectory = await mkdtemp(join(tmpdir(), "wa-web-test-"));
  const driver = createFakeDriver(driverOverrides);
  const testEnvironment = { WHATSAPP_WEB_PROFILE_DIR: profileDirectory, WHATSAPP_WEB_MIN_SEND_INTERVAL_SECONDS: "0", ...environment };
  const definition = createPluginDefinition({ createDriver: () => driver, fetchImpl, clock });
  const runOperation = createOperationRunner(definition, testEnvironment);
  return {
    runOperation: (operationName, args, source = "tool") => runOperation(operationName, args, { source }),
    driver,
    definition,
    profileDirectory,
    cleanup: () => rm(profileDirectory, { recursive: true, force: true }),
  };
}
