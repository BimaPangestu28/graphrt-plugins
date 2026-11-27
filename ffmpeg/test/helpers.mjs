/**
 * Test helpers: temporary input/output directories, a recording fake process
 * runner, and a runner over the real plugin definition.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

export const AS_NODE = { source: "node" };
export const AS_TOOL = { source: "tool" };
const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
/**
 * Why the tests that run a real ffmpeg are skipped, or false to run them. With FFMPEG_TESTS_REQUIRED=1 (the Windows and
 * macOS workflow, which installs ffmpeg) they always run, so a missing program fails there instead of skipping.
 */
export const SKIP_WITHOUT_FFMPEG = HAS_FFMPEG || process.env.FFMPEG_TESTS_REQUIRED === "1" ? false : "ffmpeg/ffprobe are not installed";

/**
 * Runs work with the system temporary directory (`os.tmpdir()`) pointed at another directory, then puts it back.
 *
 * @param directory - The directory to use (string)
 * @param work - `async () => result` (function)
 * @returns Promise of work's result
 */
export async function withTemporaryDirectory(directory, work) {
  const variableNames = ["TMPDIR", "TEMP", "TMP"];
  const previousValues = variableNames.map((variableName) => process.env[variableName]);
  for (const variableName of variableNames) process.env[variableName] = directory;
  try {
    return await work();
  } finally {
    for (const [index, variableName] of variableNames.entries()) {
      if (previousValues[index] === undefined) delete process.env[variableName];
      else process.env[variableName] = previousValues[index];
    }
  }
}

/**
 * A fake process runner: records each request; ffmpeg "writes" bytes to its output path, ffprobe prints JSON.
 *
 * @param options - `{probeResult, outputBytes, failWith}` (object, optional)
 * @returns `{runProcess, requests}` (object)
 */
export function createFakeProcessRunner({ probeResult = { format: { format_name: "mov,mp4", duration: "1.0" }, streams: [] }, outputBytes = 100, failWith } = {}) {
  const requests = [];
  const runProcess = async (request) => {
    requests.push(request);
    if (failWith) return { exitCode: 1, signalCode: null, stdout: Buffer.alloc(0), stdoutTruncated: false, stderr: failWith };
    if (request.displayName === "ffprobe") return { exitCode: 0, signalCode: null, stdout: Buffer.from(JSON.stringify(probeResult)), stdoutTruncated: false, stderr: "" };
    const outputPath = request.args.at(-1).replace(/^file:/, "");
    await writeFile(outputPath, Buffer.alloc(outputBytes, 1));
    return { exitCode: 0, signalCode: null, stdout: Buffer.alloc(0), stdoutTruncated: false, stderr: "" };
  };
  return { runProcess, requests };
}

/**
 * Creates temp directories and an operation runner for them.
 *
 * @param options - `{runProcess, environment}` (object)
 * @param work - `async ({runOperation, inputDirectory, outputDirectory, outsideDirectory}) => void` (function)
 * @returns Promise of work's result
 */
export async function withFfmpegRunner({ runProcess, environment = {} } = {}, work) {
  const baseDirectory = await realpath(await mkdtemp(join(tmpdir(), "graphrt-ffmpeg-test-")));
  const directories = { inputDirectory: join(baseDirectory, "in"), outputDirectory: join(baseDirectory, "out"), outsideDirectory: join(baseDirectory, "outside") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const definition = createPluginDefinition(runProcess ? { runProcess } : {});
  const runOperation = createOperationRunner(definition, { FFMPEG_INPUT_DIRS: directories.inputDirectory, FFMPEG_OUTPUT_DIR: directories.outputDirectory, ...environment });
  try {
    return await work({ runOperation, ...directories });
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
}

/**
 * Generates a small test video with ffmpeg's own lavfi test source (run by the test, never through the plugin).
 *
 * @param outputPath - Where to write the mp4 (string)
 * @param options - `{seconds, size}` (object, optional)
 */
export function generateTestVideo(outputPath, { seconds = 1, size = "320x240" } = {}) {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=${size}:rate=10`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", outputPath,
  ]);
  if (result.status !== 0) throw new Error(`could not generate a test video: ${result.error?.message ?? result.stderr}`);
}

/**
 * Decodes one frame of a video to 8-bit grey pixels with ffmpeg (run by the test, never through the plugin).
 *
 * @param videoPath - The video file (string)
 * @param atSeconds - Time of the frame (number)
 * @returns One byte per pixel, row by row (Buffer)
 */
export function readGreyFrame(videoPath, atSeconds) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(atSeconds), "-i", videoPath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 || result.stdout.length === 0) throw new Error(`could not read a frame of ${videoPath}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

/**
 * Counts the pixels whose brightness differs clearly between two frames of the same size (encoder noise stays below).
 *
 * @param firstFrame - From readGreyFrame (Buffer)
 * @param secondFrame - From readGreyFrame (Buffer)
 * @returns Number of pixels more than 96 of 255 apart (number)
 */
export function countChangedPixels(firstFrame, secondFrame) {
  if (firstFrame.length !== secondFrame.length) throw new Error(`frames differ in size: ${firstFrame.length} and ${secondFrame.length} bytes`);
  let changedPixels = 0;
  for (let index = 0; index < firstFrame.length; index += 1) {
    if (Math.abs(firstFrame[index] - secondFrame[index]) > 96) changedPixels += 1;
  }
  return changedPixels;
}
