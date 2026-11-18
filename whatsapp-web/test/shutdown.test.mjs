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

test("waitForIdle resolves at once when nothing runs", async () => {
  assert.equal(await createOperationTracker().waitForIdle(1000), "idle");
});

test("waitForIdle waits for running operations, including ones that fail", async () => {
  const tracker = createOperationTracker();
  const firstOperation = createDeferred();
  const succeeding = tracker.track(() => firstOperation.promise);
  const failing = tracker.track(async () => {
    throw new Error("boom");
  });
  await assert.rejects(failing, /boom/);
  const idlePromise = tracker.waitForIdle(5000);
  assert.equal(tracker.runningCount(), 1);
  firstOperation.resolve("done");
  assert.equal(await succeeding, "done");
  assert.equal(await idlePromise, "idle");
  assert.equal(tracker.runningCount(), 0);
});

test("waitForIdle gives up after its bound", async () => {
  const tracker = createOperationTracker();
  tracker.track(() => new Promise(() => {}));
  assert.equal(await tracker.waitForIdle(10), "timeout");
});

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
  assert.deepEqual(events, [], "the browser stays open while the operation runs");
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

test("a signal shuts down without waiting for running operations", async () => {
  const events = [];
  const tracker = createOperationTracker();
  tracker.track(() => new Promise(() => {}));
  const fakeProcess = new EventEmitter();
  const shutdown = installTestShutdown(events, tracker, { processObject: fakeProcess });
  fakeProcess.emit("SIGTERM");
  await shutdown("again");
  assert.deepEqual(events, ["close", "exit:0"]);
});

test("the plugin definition tracks every running operation", async () => {
  const listCall = createDeferred();
  const { runOperation, definition, driver, cleanup } = await createTestRunner({ driverOverrides: { listChats: () => listCall.promise } });
  try {
    const listPromise = runOperation("list_chats", {});
    while (driver.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await definition.waitForRunningOperations(10), "timeout");
    listCall.resolve([]);
    await listPromise;
    assert.equal(await definition.waitForRunningOperations(10), "idle");
  } finally {
    await cleanup();
  }
});
