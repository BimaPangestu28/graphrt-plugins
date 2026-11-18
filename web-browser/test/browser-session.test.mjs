import { test } from "node:test";
import assert from "node:assert/strict";
import { CHROMIUM_ARGS, createBrowserSession, describeAbort } from "../lib/browser-session.mjs";
import { createSlotLimiter } from "../lib/slot-limiter.mjs";
import { createFakeLauncher, createFakeTimers } from "./helpers.mjs";

function createSession(overrides = {}) {
  const launcher = overrides.launcher ?? createFakeLauncher();
  const timers = createFakeTimers();
  const session = createBrowserSession({ idleTimeoutMs: 60000, maxConcurrentPages: 2, launchBrowser: launcher, timers, ...overrides });
  return { session, launcher, timers };
}

test("the browser starts lazily, once, even for concurrent first calls", async () => {
  const { session, launcher } = createSession();
  assert.equal(session.isOpen(), false);
  await Promise.all([session.withContext({}, async () => "a"), session.withContext({}, async () => "b")]);
  assert.equal(launcher.launchCount, 1);
  assert.equal(session.isOpen(), true);
});

test("every call gets a fresh context with the given options, closed afterwards", async () => {
  const { session, launcher } = createSession();
  const result = await session.withContext({ acceptDownloads: false }, async (context) => {
    assert.equal(context.closed, false);
    return "done";
  });
  await session.withContext({ acceptDownloads: false }, async () => {});
  assert.equal(result, "done");
  assert.equal(launcher.contexts.length, 2);
  assert.notEqual(launcher.contexts[0], launcher.contexts[1]);
  assert.ok(launcher.contexts.every((context) => context.closed && context.options.acceptDownloads === false));
});

test("the context is closed when the task fails", async () => {
  const { session, launcher } = createSession();
  await assert.rejects(session.withContext({}, async () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(launcher.contexts[0].closed, true);
});

test("the browser closes after the idle timeout, and relaunches on the next call", async () => {
  const { session, launcher, timers } = createSession();
  await session.withContext({}, async () => {});
  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0].delayMs, 60000);
  await timers.fireAll();
  assert.equal(session.isOpen(), false);
  assert.equal(launcher.browsers[0].closed, true);
  await session.withContext({}, async () => {});
  assert.equal(launcher.launchCount, 2);
});

test("a call that starts before the idle timer fires cancels it", async () => {
  const { session, timers } = createSession();
  await session.withContext({}, async () => {});
  await session.withContext({}, async () => {
    assert.equal(timers.pending().length, 0);
  });
  assert.equal(timers.pending().length, 1);
});

test("cancelling closes the context and reports cancelled", async () => {
  const { session, launcher } = createSession();
  const controller = new AbortController();
  const running = session.withContext({}, async (context) => {
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.closed, true);
    throw new Error("Target page, context or browser has been closed");
  }, { signal: controller.signal });
  await assert.rejects(running, { kind: "cancelled" });
  assert.equal(launcher.contexts[0].closed, true);
});

test("a deadline signal reports timeout instead of cancelled", async () => {
  const { session } = createSession();
  // AbortSignal.timeout does not keep the event loop alive on its own.
  const keepAlive = setTimeout(() => {}, 5000);
  await assert.rejects(session.withContext({}, async () => new Promise(() => {}), { signal: AbortSignal.timeout(5) }), { kind: "timeout" });
  clearTimeout(keepAlive);
  assert.equal(describeAbort(AbortSignal.abort()).kind, "cancelled");
});

test("an already aborted signal never launches the browser", async () => {
  const { session, launcher } = createSession();
  await assert.rejects(session.withContext({}, async () => {}, { signal: AbortSignal.abort() }), { kind: "cancelled" });
  assert.equal(launcher.launchCount, 0);
});

test("a missing Chromium is reported as setup_required", async () => {
  const launcher = createFakeLauncher({ launchError: new Error("browserType.launch: Executable doesn't exist at /x/chrome-headless-shell") });
  const { session } = createSession({ launcher });
  await assert.rejects(session.withContext({}, async () => {}), { kind: "setup_required", message: /npx playwright install chromium/ });
});

test("other launch failures are browser_error", async () => {
  const { session } = createSession({ launcher: createFakeLauncher({ launchError: new Error("spawn EACCES") }) });
  await assert.rejects(session.withContext({}, async () => {}), { kind: "browser_error" });
});

test("a disconnected browser is relaunched", async () => {
  const { session, launcher } = createSession();
  await session.withContext({}, async () => {});
  launcher.browsers[0].disconnect();
  assert.equal(session.isOpen(), false);
  await session.withContext({}, async () => {});
  assert.equal(launcher.launchCount, 2);
});

test("close() shuts the browser down", async () => {
  const { session, launcher, timers } = createSession();
  await session.withContext({}, async () => {});
  await session.close();
  assert.equal(launcher.browsers[0].closed, true);
  assert.equal(timers.pending().length, 0);
});

test("at most maxConcurrentPages contexts are open at once", async () => {
  const { session } = createSession({ maxConcurrentPages: 2 });
  let openCount = 0;
  let highestOpenCount = 0;
  const task = async () => {
    openCount += 1;
    highestOpenCount = Math.max(highestOpenCount, openCount);
    await new Promise((resolve) => setTimeout(resolve, 5));
    openCount -= 1;
  };
  await Promise.all(Array.from({ length: 5 }, () => session.withContext({}, task)));
  assert.equal(highestOpenCount, 2);
});

test("the slot limiter serves waiters in order and drops aborted waiters", async () => {
  const limiter = createSlotLimiter(1);
  const releaseFirst = await limiter.acquire();
  const controller = new AbortController();
  const abandoned = limiter.acquire(controller.signal);
  const second = limiter.acquire();
  controller.abort();
  await assert.rejects(abandoned);
  assert.equal(limiter.waitingCount(), 1);
  releaseFirst();
  const releaseSecond = await second;
  assert.equal(limiter.activeCount(), 1);
  releaseSecond();
  releaseSecond();
  assert.equal(limiter.activeCount(), 0, "releasing twice is harmless");
});

test("Chromium is launched with the browser-wide WebRTC lock (the switch headless Chromium honours)", () => {
  assert.ok(CHROMIUM_ARGS.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"), CHROMIUM_ARGS.join(" "));
  assert.ok(!CHROMIUM_ARGS.includes("--webrtc-ip-handling-policy=disable_non_proxied_udp"), "the non-forced switch has no effect");
});
