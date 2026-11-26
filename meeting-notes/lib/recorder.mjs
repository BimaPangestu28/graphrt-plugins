/**
 * Recording the microphone and the computer's sound with two `pw-record` processes, watched by a small detached
 * supervisor (recording-supervisor.mjs).
 *
 * The supervisor runs on its own (its own process group, not a child of the plugin), so a recording survives the
 * host restarting or reloading the plugin. It stops the tracks when a stop is requested (`stop.request` in the
 * meeting folder, or SIGTERM), or when no meeting app has used the microphone for the auto-stop delay.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OWN_STREAM_PREFIX } from "./pipewire.mjs";

export const SUPERVISOR_PATH = fileURLToPath(new URL("./recording-supervisor.mjs", import.meta.url));

/**
 * pw-record arguments of one track, 16 kHz mono 16-bit WAV (what whisper reads).
 *
 * @param track - "mic" (default source) or "system" (the default sink's monitor) (string)
 * @param file - Output path (string)
 * @returns Arguments (Array<string>)
 */
export function trackArguments(track, file) {
  const properties = track === "system"
    ? `{ stream.capture.sink=true node.name=${OWN_STREAM_PREFIX}system media.name="graphrt meeting notes (system audio)" }`
    : `{ node.name=${OWN_STREAM_PREFIX}mic media.name="graphrt meeting notes (mic)" }`;
  return ["-P", properties, "--rate", "16000", "--channels", "1", "--format", "s16", file];
}

/**
 * Starts the detached supervisor for a meeting folder.
 *
 * @param options - `{folder, meetingsDirectory, meetingId, autoStopSeconds, environment}` (object)
 * @param spawnImpl - child_process.spawn (function, for tests)
 * @returns The supervisor's pid (number)
 */
export function startSupervisor(options, spawnImpl = spawn) {
  const payload = Buffer.from(JSON.stringify({
    folder: options.folder,
    meetingsDirectory: options.meetingsDirectory,
    meetingId: options.meetingId,
    autoStopSeconds: options.autoStopSeconds,
  })).toString("base64url");
  const child = spawnImpl(process.execPath, [SUPERVISOR_PATH, payload], {
    detached: true,
    stdio: "ignore",
    env: options.environment,
    cwd: options.folder,
  });
  child.unref();
  return child.pid;
}
