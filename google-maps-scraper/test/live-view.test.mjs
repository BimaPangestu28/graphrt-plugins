import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildFrameName, resolveLiveViewDirectory, startLiveView } from "../lib/live-view.mjs";

class FakeCdpSession extends EventEmitter {
  constructor({ failStart = false } = {}) {
    super();
    this.sentCommands = [];
    this.detached = false;
    this.failStart = failStart;
  }

  async send(method, params) {
    this.sentCommands.push({ method, params });
    if (method === "Page.startScreencast" && this.failStart) throw new Error("screencast unsupported");
  }

  async detach() {
    this.detached = true;
  }

  paint(text, sessionId = 1) {
    this.emit("Page.screencastFrame", { data: Buffer.from(text).toString("base64"), sessionId });
  }
}

function createFakePage(session) {
  return { context: () => ({ newCDPSession: async () => session }) };
}

function createLiveViewDirectory() {
  return join(mkdtempSync(join(tmpdir(), "live-view-test-")), "frames");
}

/** A fixed start for the fake clock. The writer compares times with `Date.now()`, so it must not start at 0. */
const FAKE_CLOCK_START_MS = Date.UTC(2026, 0, 1);
/** How long a condition may take in real time before the test fails. Only a failing test ever waits this long. */
const CONDITION_TIMEOUT_MS = 10000;
/** Real time given to a write that must not happen, so that it would be seen if it did. */
const UNWANTED_WRITE_GRACE_MS = 50;

/**
 * Puts the writer's throttle and keepalive timers and `Date` under the test's control, so a test moves time
 * itself with `mock.timers.tick()` and no result depends on how fast the machine is. File writes stay real.
 * The real timers come back when the test ends.
 *
 * @param testContext - The context node:test passes to the test function (object)
 */
function useFakeClock(testContext) {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: FAKE_CLOCK_START_MS });
  testContext.after(() => mock.timers.reset());
}

/**
 * Waits for real work (a file write) to finish, without moving the fake clock.
 * Every turn it runs the timers that are already due, because the writer may schedule a due timer only once
 * its previous write has settled.
 *
 * @param isDone - Returns true once the awaited state is reached (function)
 * @param description - What is awaited, for the failure message (string)
 * @param beforeEachCheck - Runs before every check, e.g. to advance the fake clock (function, optional)
 */
async function waitUntil(isDone, description, beforeEachCheck = () => {}) {
  const deadline = performance.now() + CONDITION_TIMEOUT_MS;
  for (;;) {
    beforeEachCheck();
    mock.timers.tick(0);
    if (isDone()) return;
    if (performance.now() > deadline) throw new Error(`timed out after ${CONDITION_TIMEOUT_MS} ms waiting for ${description}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Lets real time pass without moving the fake clock, running the timers that are due meanwhile.
 * A timer the writer wrongly scheduled as due fires here and its write reaches the disk.
 *
 * @param realMs - Real milliseconds to wait (number)
 */
async function letRealTimePass(realMs) {
  const deadline = performance.now() + realMs;
  while (performance.now() < deadline) {
    mock.timers.tick(0);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function readFrameText(framePath) {
  return existsSync(framePath) ? readFileSync(framePath, "utf8") : null;
}

async function waitForFrameText(framePath, expectedText) {
  await waitUntil(() => readFrameText(framePath) === expectedText, `the frame file to contain "${expectedText}"`);
}

test("resolveLiveViewDirectory accepts only absolute folders", () => {
  assert.equal(resolveLiveViewDirectory({}), null);
  assert.equal(resolveLiveViewDirectory({ GRAPHRT_LIVE_VIEW_DIR: "  " }), null);
  assert.equal(resolveLiveViewDirectory({ GRAPHRT_LIVE_VIEW_DIR: "relative/dir" }), null);
  assert.equal(resolveLiveViewDirectory({ GRAPHRT_LIVE_VIEW_DIR: "/tmp/live" }), "/tmp/live");
});

test("buildFrameName encodes the node id in hex and adds a unique suffix", () => {
  const frameName = buildFrameName("search_maps");
  const [prefix, encodedNodeId, uniqueSuffix] = frameName.split(".");
  assert.equal(prefix, "node");
  assert.equal(Buffer.from(encodedNodeId, "hex").toString("utf8"), "search_maps");
  assert.match(uniqueSuffix, /^[0-9a-f]{12}$/);
  assert.notEqual(buildFrameName("search_maps"), frameName);
});

test("buildFrameName falls back to page.<suffix> without a usable node id", () => {
  assert.match(buildFrameName(null), /^page\.[0-9a-f]{12}$/);
  assert.match(buildFrameName(""), /^page\.[0-9a-f]{12}$/);
  assert.match(buildFrameName("x".repeat(101)), /^page\.[0-9a-f]{12}$/);
});

test("startLiveView does nothing without a folder", async () => {
  let sessionsOpened = 0;
  const page = { context: () => ({ newCDPSession: async () => (sessionsOpened += 1) }) };
  const liveView = await startLiveView(page, { directory: null, frameName: "page.abc" });
  await liveView.stop();
  assert.equal(sessionsOpened, 0);
});

test("startLiveView starts a small JPEG screencast and writes the latest frame atomically", async (testContext) => {
  const directory = createLiveViewDirectory();
  const session = new FakeCdpSession();
  useFakeClock(testContext);
  const liveView = await startLiveView(createFakePage(session), { directory, frameName: "page.abc", intervalMs: 20 });
  const startCommand = session.sentCommands.find((command) => command.method === "Page.startScreencast");
  assert.deepEqual(startCommand.params, { format: "jpeg", quality: 60, maxWidth: 960, maxHeight: 720, everyNthFrame: 1 });

  session.paint("frame-1", 7);
  await waitForFrameText(join(directory, "page.abc.jpg"), "frame-1");
  assert.ok(session.sentCommands.some((command) => command.method === "Page.screencastFrameAck" && command.params.sessionId === 7));
  assert.deepEqual(readdirSync(directory), ["page.abc.jpg"]);
  await liveView.stop();
});

test("startLiveView writes at most one frame per interval, keeping the newest", async (testContext) => {
  const directory = createLiveViewDirectory();
  const session = new FakeCdpSession();
  const framePath = join(directory, "page.abc.jpg");
  useFakeClock(testContext);
  const liveView = await startLiveView(createFakePage(session), { directory, frameName: "page.abc", intervalMs: 80 });
  // The first frame is written at once, at fake time 0.
  session.paint("frame-1");
  await waitForFrameText(framePath, "frame-1");

  mock.timers.tick(40);
  session.paint("frame-2");
  session.paint("frame-3");
  // 79 ms after the first write the interval has not passed, so nothing may be written yet.
  mock.timers.tick(39);
  await letRealTimePass(UNWANTED_WRITE_GRACE_MS);
  assert.equal(readFrameText(framePath), "frame-1");

  // At 80 ms the newest waiting frame is written; frame-2 never reaches the disk.
  mock.timers.tick(1);
  await waitForFrameText(framePath, "frame-3");
  await liveView.stop();
});

test("a quiet page keeps its frame file fresh", async (testContext) => {
  const directory = createLiveViewDirectory();
  const session = new FakeCdpSession();
  const framePath = join(directory, "page.abc.jpg");
  useFakeClock(testContext);
  const liveView = await startLiveView(createFakePage(session), { directory, frameName: "page.abc", intervalMs: 10, keepAliveMs: 30 });
  session.paint("frame-1");
  await waitForFrameText(framePath, "frame-1");
  const longAgo = new Date(Date.now() - 60000);
  utimesSync(framePath, longAgo, longAgo);
  // The keepalive starts once the write has settled, so the clock advances one keepalive period per check
  // until a refresh lands. No frame arrives meanwhile.
  await waitUntil(
    () => Date.now() - statSync(framePath).mtimeMs < 5000,
    "the keepalive to refresh the file time",
    () => mock.timers.tick(30),
  );
  assert.equal(readFileSync(framePath, "utf8"), "frame-1");
  await liveView.stop();
});

test("stop ends the screencast, detaches and deletes the frame", async () => {
  const directory = createLiveViewDirectory();
  const session = new FakeCdpSession();
  const liveView = await startLiveView(createFakePage(session), { directory, frameName: "page.abc", intervalMs: 10 });
  session.paint("frame-1");
  await sleep(30);
  await liveView.stop();
  session.paint("after-stop");
  await sleep(30);
  assert.ok(session.sentCommands.some((command) => command.method === "Page.stopScreencast"));
  assert.equal(session.detached, true);
  assert.equal(existsSync(join(directory, "page.abc.jpg")), false);
  assert.deepEqual(readdirSync(directory), []);
});

test("a screencast that cannot start turns live view off without throwing", async () => {
  const directory = createLiveViewDirectory();
  const session = new FakeCdpSession({ failStart: true });
  const liveView = await startLiveView(createFakePage(session), { directory, frameName: "page.abc", logPrefix: "[test]" });
  session.paint("frame-1");
  await sleep(20);
  assert.deepEqual(readdirSync(directory), []);
  await liveView.stop();
});
