import { test } from "node:test";
import assert from "node:assert/strict";
import { bindAbortToBrowser, toCancelledIfAborted, createDeadlineSignal } from "../lib/cancellation.mjs";

function createFakeBrowser() {
  return { closeCount: 0, async close() { this.closeCount += 1; } };
}

test("bindAbortToBrowser closes the browser as soon as the signal aborts", () => {
  const abortController = new AbortController();
  const fakeBrowser = createFakeBrowser();
  bindAbortToBrowser(abortController.signal, fakeBrowser);
  assert.equal(fakeBrowser.closeCount, 0);
  abortController.abort();
  assert.equal(fakeBrowser.closeCount, 1);
});

test("bindAbortToBrowser closes immediately when already aborted", () => {
  const fakeBrowser = createFakeBrowser();
  bindAbortToBrowser(AbortSignal.abort(), fakeBrowser);
  assert.equal(fakeBrowser.closeCount, 1);
});

test("bindAbortToBrowser unbind stops a later abort from closing", () => {
  const abortController = new AbortController();
  const fakeBrowser = createFakeBrowser();
  const unbind = bindAbortToBrowser(abortController.signal, fakeBrowser);
  unbind();
  abortController.abort();
  assert.equal(fakeBrowser.closeCount, 0);
});

test("bindAbortToBrowser tolerates a missing signal", () => {
  const unbind = bindAbortToBrowser(undefined, createFakeBrowser());
  assert.equal(typeof unbind, "function");
});

test("toCancelledIfAborted turns any error into kind cancelled after abort", () => {
  const converted = toCancelledIfAborted(new Error("Target page, context or browser has been closed"), AbortSignal.abort());
  assert.equal(converted.kind, "cancelled");
});

test("toCancelledIfAborted keeps the original error when not aborted", () => {
  const originalError = new Error("boom");
  assert.equal(toCancelledIfAborted(originalError, new AbortController().signal), originalError);
  assert.equal(toCancelledIfAborted(originalError, undefined), originalError);
});

test("createDeadlineSignal aborts after the deadline", async () => {
  const deadlineSignal = createDeadlineSignal(20);
  assert.equal(deadlineSignal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(deadlineSignal.aborted, true);
});
