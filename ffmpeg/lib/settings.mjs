/**
 * Reads the ffmpeg plugin's environment: the file allowlist, the program
 * paths and the per-run timeout.
 */
import { fileAccessVariableNames, readFileAccessSettings } from "./file-access.mjs";
import { readExecutable, readInteger } from "./environment-readers.mjs";

export const ENVIRONMENT_PREFIX = "FFMPEG";
export const FILE_VARIABLES = fileAccessVariableNames(ENVIRONMENT_PREFIX);
export const PROGRAM_VARIABLES = ["FFMPEG_BINARY", "FFPROBE_BINARY"];
export const MEDIA_LIMIT_VARIABLES = ["FFMPEG_MAX_INPUT_PIXELS", "FFMPEG_MAX_INPUT_SECONDS", "FFMPEG_THREADS"];
export const TIMEOUT_VARIABLE = "FFMPEG_TIMEOUT_MS";
/** The manifest's per-call limit; a run's own timeout stays below it so its error still reaches the caller. */
export const CALL_TIMEOUT_MS = 1800000;
const GIBIBYTE = 1024 ** 3;

/**
 * Builds settings from environment variables.
 *
 * @param environment - Environment variables (object)
 * @returns `{files, ffmpegCommand, ffprobeCommand, timeoutMs, maxPixels, maxToolInputSeconds, threads}` (object)
 * @throws PluginError kind `invalid_input` - When a variable has an invalid value
 */
export function readFfmpegSettings(environment = {}) {
  return {
    files: readFileAccessSettings(environment, {
      prefix: ENVIRONMENT_PREFIX,
      defaultMaxInputBytes: 2 * GIBIBYTE,
      defaultMaxOutputBytes: 2 * GIBIBYTE,
      maxBytesCeiling: 64 * GIBIBYTE,
    }),
    ffmpegCommand: readExecutable(environment, "FFMPEG_BINARY", "ffmpeg"),
    ffprobeCommand: readExecutable(environment, "FFPROBE_BINARY", "ffprobe"),
    timeoutMs: readInteger(environment, TIMEOUT_VARIABLE, 600000, { minimum: 1000, maximum: CALL_TIMEOUT_MS - 20000 }),
    maxPixels: readInteger(environment, "FFMPEG_MAX_INPUT_PIXELS", 7680 * 4320, { minimum: 10000, maximum: 268435456 }),
    maxToolInputSeconds: readInteger(environment, "FFMPEG_MAX_INPUT_SECONDS", 3600, { minimum: 1, maximum: 86400 }),
    threads: readInteger(environment, "FFMPEG_THREADS", 4, { minimum: 1, maximum: 64 }),
  };
}
