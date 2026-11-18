import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createOperationTracker } from "../lib/operation-tracker.mjs";
import { installShutdownHandlers } from "../lib/shutdown.mjs";
import { createTestRunner } from "./helpers.mjs";

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function installTestShutdown(events, tracker, overrides = {}) {
  return installShutdownHandlers({
    closeAllClients: async () => events.push("close"),
    waitForRunningOperations: (timeoutMs) => tracker.waitForIdle(timeoutMs),
    processObject: new EventEmitter(),
    exit: (exitCode) => events.push(`exit:${exitCode}`),
    ...overrides,
  });
}

test("ending stdin lets a running operation finish before the browser closes", async () => {
  const events = [];
  const tracker = createOperationTracker();
  const runningOperation = createDeferred();
  tracker.track(async () => {
    await runningOperation.promise;
    events.push("operation finished");
  });
  const shutdownPromise = installTestShutdown(events, tracker)("host closed the connection", { letRunningFinish: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, []);
  runningOperation.resolve();
  await shutdownPromise;
  assert.deepEqual(events, ["operation finished", "close", "exit:0"]);
});

test("the wait for running operations on stdin end is bounded", async () => {
  const events = [];
  const tracker = createOperationTracker();
  tracker.track(() => new Promise(() => {}));
  await installTestShutdown(events, tracker, { drainTimeoutMs: 10 })("host closed the connection", { letRunningFinish: true });
  assert.deepEqual(events, ["close", "exit:0"]);
});

test("a signal closes the browser at once, and only once", async () => {
  const events = [];
  const tracker = createOperationTracker();
  tracker.track(() => new Promise(() => {}));
  const fakeProcess = new EventEmitter();
  const shutdown = installTestShutdown(events, tracker, { processObject: fakeProcess });
  fakeProcess.emit("SIGTERM");
  fakeProcess.emit("SIGINT");
  await shutdown("again");
  assert.deepEqual(events, ["close", "exit:0"]);
});

test("the plugin definition tracks running operations and closes its browser", async () => {
  const gate = createDeferred();
  const runner = await createTestRunner({ pageOptions: { gotoGate: gate.promise } });
  try {
    const { runOperation, definition, launcher } = runner;
    const pending = runOperation("fetch_page", { url: "https://example.com/" });
    while (!launcher.contexts[0]?.pages[0]) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await definition.waitForRunningOperations(20), "timeout");
    gate.resolve();
    await pending;
    assert.equal(await definition.waitForRunningOperations(20), "idle");
    await definition.closeAllClients();
    assert.equal(launcher.browsers[0].closed, true);
  } finally {
    await runner.cleanup();
  }
});

test("waitForRunningOperations reports a timeout while an operation is still running", async () => {
  const tracker = createOperationTracker();
  tracker.track(() => new Promise(() => {}));
  assert.equal(await tracker.waitForIdle(10), "timeout");
  assert.equal(tracker.runningCount(), 1);
});
