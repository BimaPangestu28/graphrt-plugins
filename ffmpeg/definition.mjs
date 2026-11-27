/**
 * ffmpeg plugin definition: probe, convert, cut, join and render media files
 * with the system ffmpeg/ffprobe, on files inside FFMPEG_INPUT_DIRS, writing
 * new files to FFMPEG_OUTPUT_DIR.
 *
 * There is no token and no network (`localOnly`, `noCredentials`). ffmpeg runs
 * with an argument array (never a shell), input protocol and demuxer
 * whitelists, a size cap, a timeout and SIGKILL on cancel.
 */
import { createFfmpegClient } from "./lib/client.mjs";
import { CALL_TIMEOUT_MS, FILE_VARIABLES, MEDIA_LIMIT_VARIABLES, PROGRAM_VARIABLES, TIMEOUT_VARIABLE } from "./lib/settings.mjs";
import { probeOperation } from "./operations/probe.mjs";
import { encodeOperations } from "./operations/encode.mjs";
import { combineOperations } from "./operations/combine.mjs";
import { frameOperations } from "./operations/frames.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{runProcess, fileAccessDependencies}` overrides (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  return {
    name: "ffmpeg",
    version: "0.1.2",
    description: "Local media with the system ffmpeg: probe, convert (fixed presets), trim, extract audio, thumbnails, resize, join, burn subtitles and GIFs, on files in allowed directories",
    extraEnv: [FILE_VARIABLES.inputDirs, FILE_VARIABLES.outputDir, FILE_VARIABLES.maxInputBytes, FILE_VARIABLES.maxOutputBytes, TIMEOUT_VARIABLE, ...MEDIA_LIMIT_VARIABLES, ...PROGRAM_VARIABLES],
    localOnly: true,
    noCredentials: true,
    limits: { timeout_ms: CALL_TIMEOUT_MS, max_concurrency: 2 },
    createClient: ({ environment }) => createFfmpegClient(environment, dependencies),
    operations: [probeOperation, ...encodeOperations, ...combineOperations, ...frameOperations],
  };
}

export const pluginDefinition = createPluginDefinition();
