/**
 * Test helpers: temporary input/output directories, a runner over the real
 * plugin definition, and generated test images. sharp-backed tests skip when
 * sharp is not installed (`npm install` in image-tools).
 */
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

export const AS_TOOL = { source: "tool" };
export const sharp = (await import("sharp").catch(() => null))?.default ?? null;
export const SKIP_WITHOUT_SHARP = sharp ? false : "sharp is not installed (run npm install in image-tools)";

/**
 * Creates temp directories and an operation runner for them.
 *
 * @param options - `{environment, dependencies}` (object)
 * @param work - `async ({runOperation, inputDirectory, outputDirectory, outsideDirectory}) => void` (function)
 * @returns Promise of work's result
 */
export async function withImageRunner({ environment = {}, dependencies = {} } = {}, work) {
  const baseDirectory = await realpath(await mkdtemp(join(tmpdir(), "graphrt-image-test-")));
  const directories = { inputDirectory: join(baseDirectory, "in"), outputDirectory: join(baseDirectory, "out"), outsideDirectory: join(baseDirectory, "outside") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const runOperation = createOperationRunner(createPluginDefinition(dependencies), {
    IMAGE_TOOLS_INPUT_DIRS: directories.inputDirectory,
    IMAGE_TOOLS_OUTPUT_DIR: directories.outputDirectory,
    ...environment,
  });
  try {
    return await work({ runOperation, ...directories });
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
}

/**
 * Writes a generated image (a two-colour test card) with sharp.
 *
 * @param filePath - Output path; the extension picks the format (string)
 * @param options - `{width, height, orientation}` (object, optional)
 */
export async function writeTestImage(filePath, { width = 400, height = 200, orientation } = {}) {
  const halfBlock = await sharp({ create: { width: Math.floor(width / 2), height, channels: 3, background: "#ff0000" } }).png().toBuffer();
  let pipeline = sharp({ create: { width, height, channels: 3, background: "#0000ff" } }).composite([{ input: halfBlock, left: 0, top: 0 }]);
  if (orientation) pipeline = pipeline.withMetadata({ orientation });
  await pipeline.toFile(filePath);
}
