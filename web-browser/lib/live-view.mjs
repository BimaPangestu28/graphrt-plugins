/**
 * Live view: small JPEG frames of what a headless page shows, for a host app
 * that displays them while a step runs (the graphrt desktop app).
 *
 * The host opts in by setting `GRAPHRT_LIVE_VIEW_DIR` to an absolute folder.
 * Without it every function here is a no-op, so plugins behave as before.
 *
 * - Frames come from Chromium's screencast (CDP `Page.startScreencast`), which
 *   only paints when the page changes and keeps working across navigations.
 * - At most one frame per `intervalMs` is written (the latest one wins), as
 *   `<dir>/<frameName>.jpg`, atomically (temp file + rename).
 * - While the page shows no change, the file's modification time is refreshed
 *   every `keepAliveMs`, so the host can tell a quiet page from a crashed plugin.
 * - `stop()` ends the screencast and deletes the frame file.
 * - Frames stay on this machine; they are never logged or sent over the protocol.
 *
 * File names (read by the host): `node.<hex node id>.<random>.jpg` for a
 * workflow node, `page.<random>.jpg` when the node is not known (tool calls).
 *
 * This file is copied verbatim into every browser plugin's `lib/` (a test
 * checks the copies match); edit google-maps-scraper/lib/live-view.mjs first.
 */
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const LIVE_VIEW_DIRECTORY_VARIABLE = "GRAPHRT_LIVE_VIEW_DIR";
/** ~6 frames per second: smooth enough to follow scrolling, light on disk and CPU. */
export const DEFAULT_FRAME_INTERVAL_MS = 166;
export const DEFAULT_KEEP_ALIVE_MS = 5000;
/** 960 px wide keeps text legible in a ~560 px view on a 2x screen; frames are ~75 KB. */
const MAX_FRAME_WIDTH = 960;
const MAX_FRAME_HEIGHT = 720;
const FRAME_QUALITY = 60;
/** Longer node ids are not encoded into file names; their frames show as "unknown node". */
const MAX_NODE_ID_LENGTH = 100;
const INACTIVE_LIVE_VIEW = Object.freeze({ stop: async () => {} });

/**
 * Reads the live view folder from the environment.
 *
 * @param environment - Environment variables (object)
 * @returns The absolute folder, or null when live view is off or the value is not absolute (string | null)
 */
export function resolveLiveViewDirectory(environment = process.env) {
  const configuredPath = environment[LIVE_VIEW_DIRECTORY_VARIABLE]?.trim();
  return configuredPath && isAbsolute(configuredPath) ? configuredPath : null;
}

/**
 * Builds a unique frame name for one browser page.
 *
 * @param nodeId - Workflow node id the page belongs to, or null/"" for tool calls (string | null)
 * @returns `node.<hex>.<random>` or `page.<random>` (string)
 *
 * @example
 * buildFrameName("search") // "node.736561726368.1f2e3d4c5b6a"
 */
export function buildFrameName(nodeId) {
  const uniqueSuffix = randomBytes(6).toString("hex");
  if (!nodeId || nodeId.length > MAX_NODE_ID_LENGTH) return `page.${uniqueSuffix}`;
  return `node.${Buffer.from(nodeId, "utf8").toString("hex")}.${uniqueSuffix}`;
}

/**
 * Starts writing live frames of `page` when a live view folder is configured.
 * Never throws: a failure only turns live view off for this page (one stderr line).
 *
 * @param page - Playwright Chromium page (object)
 * @param options - Live view options (object, optional)
 * @param options.directory - Folder from resolveLiveViewDirectory; null turns live view off (string | null)
 * @param options.frameName - From buildFrameName (string)
 * @param options.intervalMs - Minimum time between two written frames (number, optional)
 * @param options.keepAliveMs - How often the frame file's time is refreshed (number, optional)
 * @param options.logPrefix - Prefix for the stderr line on failure (string, optional)
 * @returns `{stop()}`; `stop` ends the screencast and removes the frame file (Promise<object>)
 *
 * @example
 * const liveView = await startLiveView(page, { directory: resolveLiveViewDirectory(), frameName: buildFrameName(nodeId) });
 * try { ... } finally { await liveView.stop(); }
 */
export async function startLiveView(page, options = {}) {
  const { directory, frameName, logPrefix = "[live-view]" } = options;
  if (!directory || !frameName) return INACTIVE_LIVE_VIEW;
  const intervalMs = options.intervalMs ?? DEFAULT_FRAME_INTERVAL_MS;
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  const writer = createFrameWriter({ directory, frameName, intervalMs, keepAliveMs, logPrefix });
  try {
    await mkdir(directory, { recursive: true });
    const session = await page.context().newCDPSession(page);
    writer.attach(session);
    session.on("Page.screencastFrame", (frameEvent) => writer.receive(session, frameEvent));
    await session.send("Page.startScreencast", {
      format: "jpeg",
      quality: FRAME_QUALITY,
      maxWidth: MAX_FRAME_WIDTH,
      maxHeight: MAX_FRAME_HEIGHT,
      everyNthFrame: 1,
    });
  } catch (startError) {
    writer.fail(startError);
  }
  return { stop: () => writer.stop() };
}

/** Throttled, atomic frame writes for one page (see startLiveView). */
function createFrameWriter({ directory, frameName, intervalMs, keepAliveMs, logPrefix }) {
  const framePath = join(directory, `${frameName}.jpg`);
  const temporaryPath = join(directory, `.${frameName}.tmp`);
  const state = { session: null, latestFrame: null, lastWriteAt: 0, timer: null, keepAlive: null, writing: null, stopped: false };

  const startKeepAlive = () => {
    if (state.keepAlive || state.stopped) return;
    state.keepAlive = setInterval(() => {
      if (state.writing || state.stopped) return;
      const touchedAt = new Date();
      utimes(framePath, touchedAt, touchedAt).catch(() => {});
    }, keepAliveMs);
    state.keepAlive.unref?.();
  };

  const writeLatestFrame = async () => {
    state.timer = null;
    const frameData = state.latestFrame;
    if (state.stopped || !frameData) return;
    state.latestFrame = null;
    state.lastWriteAt = Date.now();
    state.writing = writeFile(temporaryPath, Buffer.from(frameData, "base64"))
      .then(() => (state.stopped ? undefined : rename(temporaryPath, framePath)))
      .then(startKeepAlive)
      .catch((writeError) => fail(writeError));
    await state.writing;
    state.writing = null;
    if (state.latestFrame) scheduleWrite();
  };

  const scheduleWrite = () => {
    if (state.timer || state.writing || state.stopped) return;
    const waitMs = Math.max(0, state.lastWriteAt + intervalMs - Date.now());
    state.timer = setTimeout(writeLatestFrame, waitMs);
    state.timer.unref?.();
  };

  const fail = (failure) => {
    if (state.stopped) return;
    console.error(`${logPrefix} live view turned off for this page: ${failure?.message ?? failure}`);
    void stop();
  };

  const stop = async () => {
    if (state.stopped) return;
    state.stopped = true;
    clearTimeout(state.timer);
    clearInterval(state.keepAlive);
    state.timer = null;
    await state.writing;
    await state.session?.send("Page.stopScreencast").catch(() => {});
    await state.session?.detach().catch(() => {});
    await rm(framePath, { force: true }).catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  };

  return {
    attach: (session) => {
      state.session = session;
    },
    receive: (session, frameEvent) => {
      // Chromium sends the next frame only after an ack.
      session.send("Page.screencastFrameAck", { sessionId: frameEvent.sessionId }).catch(() => {});
      if (state.stopped || typeof frameEvent.data !== "string") return;
      state.latestFrame = frameEvent.data;
      scheduleWrite();
    },
    fail,
    stop,
  };
}
