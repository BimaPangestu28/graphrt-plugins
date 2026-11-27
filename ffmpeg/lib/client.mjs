/**
 * The ffmpeg client one operation call works with: allowlisted file access,
 * ffprobe as JSON, and "run ffmpeg into a new output file" with the size cap,
 * decoder limits (`-max_pixels`, `-threads`), timeout and clean-up on failure.
 *
 * ffmpeg writes into a private staging directory inside the output directory;
 * only a finished, size-checked file is linked to its generated name, so no
 * path that someone else could swap is ever reopened.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileAccess, describeOutputFile } from "./file-access.mjs";
import { createProcessRunner } from "./process-runner.mjs";
import { buildGlobalArguments, buildProbeArguments } from "./ffmpeg-arguments.mjs";
import { mapProgramFailure } from "./error-mapping.mjs";
import { invalidInput, operationFailed } from "./errors.mjs";
import { readFfmpegSettings } from "./settings.mjs";

const MAX_PROBE_OUTPUT_BYTES = 2 * 1024 * 1024;
const SETUP_HINT = "Install ffmpeg (it includes ffprobe), e.g. `brew install ffmpeg`, `apt install ffmpeg` or on Windows `winget install Gyan.FFmpeg`, or set FFMPEG_BINARY / FFPROBE_BINARY to absolute paths.";

/**
 * Creates the client for one call.
 *
 * @param environment - Environment variables (object)
 * @param dependencies - `{runProcess, fileAccessDependencies}` overrides for tests (object, optional)
 * @returns `{settings, fileAccess, probe, produceOutput, withScratchFile}` (object)
 * @throws PluginError kind `invalid_input` - When the environment is invalid
 */
export function createFfmpegClient(environment, dependencies = {}) {
  const settings = readFfmpegSettings(environment);
  const context = {
    settings,
    fileAccess: createFileAccess(settings.files, dependencies.fileAccessDependencies),
    runProcess: dependencies.runProcess ?? createProcessRunner(),
  };
  return {
    settings,
    fileAccess: context.fileAccess,
    probe: (realPath, signal) => probeFile(context, realPath, signal),
    produceOutput: (request) => produceOutput(context, request),
    withScratchFile: withScratchFile,
  };
}

async function probeFile(context, realPath, signal) {
  const runResult = await context.runProcess({
    command: context.settings.ffprobeCommand,
    args: buildProbeArguments(realPath),
    timeoutMs: context.settings.timeoutMs,
    signal,
    maxStdoutBytes: MAX_PROBE_OUTPUT_BYTES,
    displayName: "ffprobe",
    setupHint: SETUP_HINT,
  });
  if (runResult.exitCode !== 0) throw mapProgramFailure("ffprobe", runResult, context.fileAccess.redactPaths);
  if (runResult.stdoutTruncated) throw operationFailed(`ffprobe printed more than ${MAX_PROBE_OUTPUT_BYTES} bytes`);
  try {
    return JSON.parse(runResult.stdout.toString("utf8"));
  } catch (parseError) {
    throw operationFailed(`ffprobe printed invalid JSON: ${parseError.message}`);
  }
}

/**
 * Adds the decoder limits in front of every `-i`: at most `maxPixels` per decoded frame and `threads` threads.
 *
 * @param args - Input and encoding options (string[])
 * @param limits - `{maxPixels, threads}` (object)
 * @returns New argument array (string[])
 */
export function applyDecoderLimits(args, { maxPixels, threads }) {
  return args.flatMap((argument, index) => (argument === "-i" && index < args.length - 1 ? ["-max_pixels", String(maxPixels), "-threads", String(threads), "-i"] : [argument]));
}

/**
 * Runs ffmpeg into a staging file, then publishes it under a generated name.
 *
 * @param context - Client context (object)
 * @param request - `{naming: {nameHint, extension}, buildArguments: () => string[], signal}`; buildArguments returns the
 *   input and encoding options, the plugin adds decoder limits, threads, the size cap and `-n file:<staging path>` (object)
 * @returns `{path, file_name, size_bytes}` (object)
 */
async function produceOutput(context, { naming, buildArguments, signal }) {
  const staging = await context.fileAccess.createStagingOutput(naming);
  try {
    const { maxOutputBytes } = context.settings.files;
    const threads = String(context.settings.threads);
    const args = [
      ...buildGlobalArguments(), "-filter_threads", threads, ...applyDecoderLimits(buildArguments(), context.settings),
      "-threads", threads, "-fs", String(maxOutputBytes), "-n", `file:${staging.stagingPath}`,
    ];
    const runResult = await context.runProcess({
      command: context.settings.ffmpegCommand,
      args,
      timeoutMs: context.settings.timeoutMs,
      signal,
      maxStdoutBytes: 65536,
      displayName: "ffmpeg",
      setupHint: SETUP_HINT,
    });
    if (runResult.exitCode !== 0) throw mapProgramFailure("ffmpeg", runResult, context.fileAccess.redactPaths);
    const sizeBytes = await checkProducedFile(context, staging.stagingPath, maxOutputBytes);
    return describeOutputFile(await staging.publish(), sizeBytes);
  } catch (runError) {
    await staging.discard();
    throw runError;
  }
}

// `-fs` stops ffmpeg at the cap and leaves a cut-off file, which is never kept.
async function checkProducedFile(context, outputPath, maxOutputBytes) {
  const outputFile = await context.fileAccess.checkOutputFile(outputPath);
  if (outputFile.size_bytes >= maxOutputBytes) {
    throw invalidInput(`The output reached the ${maxOutputBytes}-byte limit (${context.settings.files.variables.maxOutputBytes}) and was removed`);
  }
  if (outputFile.size_bytes === 0) throw operationFailed("ffmpeg finished but wrote an empty file; it was removed");
  return outputFile.size_bytes;
}

/**
 * Writes a plugin-generated helper file (concat list, sanitised subtitles) to a private temp directory for one run.
 *
 * @param fileName - Plain file name, e.g. "list.ffconcat" (string)
 * @param content - File content (string)
 * @param work - `async (scratchPath) => result` (function)
 * @returns Promise of work's result; the directory is removed afterwards
 */
async function withScratchFile(fileName, content, work) {
  const scratchDirectory = await mkdtemp(join(tmpdir(), "graphrt-ffmpeg-"));
  try {
    const scratchPath = join(scratchDirectory, fileName);
    await writeFile(scratchPath, content, { mode: 0o600, flag: "wx" });
    return await work(scratchPath);
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}
