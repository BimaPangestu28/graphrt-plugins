/**
 * Turns a failed ffmpeg/ffprobe run into a PluginError with ffmpeg's own last message.
 */
import { invalidInput, operationFailed } from "./errors.mjs";

const INPUT_PROBLEM_PATTERNS = [
  /Invalid data found when processing input/i,
  /not on whitelist/i,
  /moov atom not found/i,
  /matches no streams/i,
  /does not contain any stream/i,
  /Invalid duration specification/i,
  /Unknown encoder/i,
];
const MAX_MESSAGE_LENGTH = 600;

/**
 * Maps a non-zero exit to `invalid_input` (unreadable or unsuitable media) or `plugin_error`.
 *
 * @param displayName - "ffmpeg" or "ffprobe" (string)
 * @param runResult - `{exitCode, signalCode, stderr}` from the process runner (object)
 * @param redactPaths - Hides paths outside the allowed directories (temp dirs, libraries) (function, optional)
 * @returns PluginError
 */
export function mapProgramFailure(displayName, { exitCode, signalCode, stderr }, redactPaths = (text) => text) {
  const detail = redactPaths(summarizeStderr(stderr)) || (signalCode ? `stopped by ${signalCode}` : `exit code ${exitCode}`);
  const message = `${displayName} failed: ${detail}`;
  return INPUT_PROBLEM_PATTERNS.some((pattern) => pattern.test(stderr ?? "")) ? invalidInput(message) : operationFailed(message);
}

// The last lines carry the reason; earlier ones repeat per-stream noise.
function summarizeStderr(stderr) {
  const lines = String(stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.slice(-4).join(" | ").slice(-MAX_MESSAGE_LENGTH);
}
