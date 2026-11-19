/**
 * Test helpers: temp directories, a recording fake process runner, and a runner over the real definition.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

export const AS_TOOL = { source: "tool" };
export const PNG_HEADER = pngHeaderClaiming(100, 50);

/**
 * Builds the first bytes of a PNG (signature and IHDR) that declare a size, without pixel data.
 *
 * @param width - Declared width (number)
 * @param height - Declared height (number)
 * @returns Header bytes (Buffer)
 */
export function pngHeaderClaiming(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}
export const SKIP_WITHOUT_TESSERACT = spawnSync("tesseract", ["--version"]).status === 0 ? false : "tesseract is not installed";
export const SKIP_WITHOUT_MAGICK = spawnSync("magick", ["-version"]).status === 0 ? false : "ImageMagick (magick) is not installed to draw a test image";

/**
 * A fake runner: `--list-langs` lists eng/ind/osd; pdftoppm writes a PNG; tesseract prints `ocrText`.
 *
 * @param options - `{ocrText, failWith}` (object, optional)
 * @returns `{runProcess, requests}` (object)
 */
export function createFakeProcessRunner({ ocrText = "Halo", failWith } = {}) {
  const requests = [];
  const respond = (stdoutText, exitCode = 0, stderr = "") => ({ exitCode, signalCode: null, stdout: Buffer.from(stdoutText), stdoutTruncated: false, stderr });
  const runProcess = async (request) => {
    requests.push(request);
    if (request.args[0] === "--list-langs") return respond('List of available languages in "/opt/tessdata/" (3):\neng\nind\nosd\n');
    if (failWith) return respond("", 1, failWith);
    if (request.displayName === "pdftoppm") {
      await writeFile(`${request.args.at(-1)}.png`, PNG_HEADER);
      return respond("");
    }
    return respond(ocrText);
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
export async function withOcrRunner({ runProcess, environment = {} } = {}, work) {
  const baseDirectory = await realpath(await mkdtemp(join(tmpdir(), "graphrt-ocr-test-")));
  const directories = { inputDirectory: join(baseDirectory, "in"), outputDirectory: join(baseDirectory, "out"), outsideDirectory: join(baseDirectory, "outside") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const runOperation = createOperationRunner(createPluginDefinition(runProcess ? { runProcess } : {}), {
    OCR_TESSERACT_INPUT_DIRS: directories.inputDirectory,
    OCR_TESSERACT_OUTPUT_DIR: directories.outputDirectory,
    ...environment,
  });
  try {
    return await work({ runOperation, ...directories });
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
}
