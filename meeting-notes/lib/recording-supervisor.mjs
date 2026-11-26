/**
 * Detached supervisor of one recording (started by recorder.mjs, never by the host). Runs the two pw-record
 * processes, checks the microphone every few seconds and stops the recording when:
 * - `stop.request` appears in the meeting folder (stop_recording), or it gets SIGTERM / SIGINT;
 * - no meeting app has used the microphone for the auto-stop delay (the meeting ended);
 * - a track's recorder exits on its own (an error).
 * Then it finishes meta.json (status "recorded", ended_at, stop_reason) and exits.
 *
 * Usage: node recording-supervisor.mjs <base64url JSON {folder, meetingsDirectory, meetingId, autoStopSeconds}>
 */
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { meetingApps } from "./apps.mjs";
import { parseMicUsers } from "./pipewire.mjs";
import { readMeeting, STOP_REQUEST_FILE, TRACKS, writeMeeting } from "./store.mjs";
import { trackArguments } from "./recorder.mjs";

const CHECK_INTERVAL_MS = 3000;
const STOP_TIMEOUT_MS = 5000;
const execFileAsync = promisify(execFile);

const options = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"));
const recorders = TRACKS.map(({ track, file }) => {
  const child = spawn("pw-record", trackArguments(track, join(options.folder, file)), { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  return { track, child, exited: false, stderr: () => stderr };
});

let stopping = null;
let lastMeetingAppAt = Date.now();

for (const recorder of recorders) {
  recorder.child.on("exit", () => {
    recorder.exited = true;
    if (!stopping) void stop("error", `pw-record (${recorder.track}) stopped: ${recorder.stderr().trim() || "no output"}`);
  });
  recorder.child.on("error", (spawnError) => {
    recorder.exited = true;
    if (!stopping) void stop("error", `pw-record (${recorder.track}) could not start: ${spawnError.message}`);
  });
}
process.on("SIGTERM", () => void stop("stopped"));
process.on("SIGINT", () => void stop("stopped"));

async function meetingAppOnMicrophone() {
  try {
    const { stdout } = await execFileAsync("pw-dump", [], { maxBuffer: 32 * 1024 * 1024, timeout: 10000 });
    return meetingApps(parseMicUsers(stdout, process.pid)).length > 0;
  } catch {
    // PipeWire hiccup: do not stop a recording because one check failed.
    return true;
  }
}

async function waitForExit(recorder) {
  if (recorder.exited) return;
  await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      recorder.child.kill("SIGKILL");
      resolveExit();
    }, STOP_TIMEOUT_MS);
    recorder.child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

function stop(reason, error = null) {
  if (stopping) return stopping;
  stopping = (async () => {
    // SIGINT makes pw-record finish the WAV header.
    for (const recorder of recorders) if (!recorder.exited) recorder.child.kill("SIGINT");
    await Promise.all(recorders.map(waitForExit));
    const meeting = await readMeeting(options.meetingsDirectory, options.meetingId);
    if (meeting) {
      await writeMeeting(options.meetingsDirectory, {
        ...meeting,
        status: "recorded",
        ended_at: new Date().toISOString(),
        stop_reason: reason,
        ...(error ? { error } : {}),
      });
    }
    process.exit(0);
  })();
  return stopping;
}

async function check() {
  if (stopping) return;
  if (existsSync(join(options.folder, STOP_REQUEST_FILE))) {
    await stop("stopped");
    return;
  }
  if (await meetingAppOnMicrophone()) lastMeetingAppAt = Date.now();
  else if (Date.now() - lastMeetingAppAt >= options.autoStopSeconds * 1000) await stop("meeting_ended");
}

setInterval(() => void check(), CHECK_INTERVAL_MS);
