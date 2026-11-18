/**
 * Screenshots through `screencapture -x` (silent). Images are saved as files for
 * workflows: agents only see text, so the result is the file path.
 *
 * A window screenshot captures that window by its CGWindowID (`-l`), so windows
 * of other apps overlapping it never appear. A full-screen screenshot shows every
 * app, so it needs COMPUTER_CONTROL_ALLOW_FULL_SCREENSHOT=1.
 */
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { ALLOW_FULL_SCREENSHOT_ENV } from "../lib/client.mjs";
import { mapScreenCaptureFailure, SCREEN_RECORDING_HINT } from "../lib/osascript-errors.mjs";
import { APP_PROPERTY, WINDOW_PROPERTY } from "./common.mjs";

const SCREENCAPTURE_PATH = "/usr/sbin/screencapture";
const SCREENCAPTURE_TIMEOUT_MS = 30000;

function buildScreenshotPath(directory, now) {
  const timestamp = now().toISOString().replace(/[:.]/g, "-");
  return join(directory, `screenshot-${timestamp}.png`);
}

// `-o` leaves out the window shadow; `-l` captures one window by id.
async function resolveCaptureArguments(client, args, signal) {
  if (!args.app) {
    client.requireOptIn(ALLOW_FULL_SCREENSHOT_ENV, "A full-screen screenshot (it shows every app)");
    return { captureArguments: [], windowId: null };
  }
  const appName = client.requireApp(args.app);
  const { window_id: windowId } = await client.runJxa("find_window_id", { app: appName, window: args.window }, { signal });
  return { captureArguments: ["-o", "-l", String(windowId)], windowId };
}

async function readFileSize(filePath) {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

async function takeScreenshot({ client, args, signal }) {
  const { captureArguments, windowId } = await resolveCaptureArguments(client, args, signal);
  await mkdir(client.screenshotDirectory, { recursive: true });
  const filePath = buildScreenshotPath(client.screenshotDirectory, client.now);
  const { exitCode, stderr } = await client.runCommand(SCREENCAPTURE_PATH, ["-x", "-t", "png", ...captureArguments, filePath], {
    signal,
    timeoutMs: SCREENCAPTURE_TIMEOUT_MS,
  });
  if (exitCode !== 0) throw mapScreenCaptureFailure(stderr);
  const bytes = await readFileSize(filePath);
  // screencapture can exit 0 without writing a file when Screen Recording is denied.
  if (bytes === 0) throw new PluginError(`${SCREEN_RECORDING_HINT} (screencapture wrote no image)`, { kind: "permission_denied" });
  return { data: { path: filePath, bytes, app: args.app ? args.app : null, window_id: windowId } };
}

export const screenOperations = [
  {
    name: "take_screenshot",
    title: "Take screenshot",
    description:
      "Save a PNG screenshot of one app window (when `app` is given; only that window, by window id) or of the main display (needs COMPUTER_CONTROL_ALLOW_FULL_SCREENSHOT=1) to COMPUTER_CONTROL_SCREENSHOT_DIR (default: a temp folder). Returns the file path; agents cannot see the image, use read_ui to read the UI.",
    parameters: {
      type: "object",
      properties: { app: { ...APP_PROPERTY, description: "Capture only this app's window (optional)" }, window: WINDOW_PROPERTY },
    },
    run: takeScreenshot,
  },
];
