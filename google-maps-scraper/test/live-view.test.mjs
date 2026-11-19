import { test } from "node:test";
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

test("startLiveView starts a small JPEG screencast and writes the latest frame atomically", async () => {
  const directory = createLiveViewDirectory();
  const session = new FakeCdpSession();
  const liveView = await startLiveView(createFakePage(session), { directory, frameName: "page.abc", intervalMs: 20 });
  const startCommand = session.sentCommands.find((command) => command.method === "Page.startScreencast");
  assert.deepEqual(startCommand.params, { format: "jpeg", quality: 50, maxWidth: 640, maxHeight: 480, everyNthFrame: 1 });

  session.paint("frame-1", 7);
  await sleep(40);
  assert.equal(readFileSync(join(directory, "page.abc.jpg"), "utf8"), "frame-1");
  assert.ok(session.sentCommands.some((command) => command.method === "Page.screencastFrameAck" && command.params.sessionId === 7));
  assert.deepEqual(readdirSync(directory), ["page.abc.jpg"]);
  await liveView.stop();
});

test("startLiveView writes at most one frame per interval, keeping the newest", async () => {
  const directory = createLiveViewDirectory();
  const session = new FakeCdpSession();
  const liveView = await startLiveView(createFakePage(session), { directory, frameName: "page.abc", intervalMs: 80 });
  session.paint("frame-1");
  await sleep(20);
  session.paint("frame-2");
  session.paint("frame-3");
  await sleep(20);
  assert.equal(readFileSync(join(directory, "page.abc.jpg"), "utf8"), "frame-1");
  await sleep(100);
  assert.equal(readFileSync(join(directory, "page.abc.jpg"), "utf8"), "frame-3");
  await liveView.stop();
});

test("a quiet page keeps its frame file fresh", async () => {
  const directory = createLiveViewDirectory();
  const session = new FakeCdpSession();
  const liveView = await startLiveView(createFakePage(session), { directory, frameName: "page.abc", intervalMs: 10, keepAliveMs: 30 });
  session.paint("frame-1");
  await sleep(20);
  const framePath = join(directory, "page.abc.jpg");
  const longAgo = new Date(Date.now() - 60000);
  utimesSync(framePath, longAgo, longAgo);
  await sleep(60);
  assert.ok(Date.now() - statSync(framePath).mtimeMs < 5000, "the keepalive did not refresh the file time");
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
