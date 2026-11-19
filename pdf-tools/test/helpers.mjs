/**
 * Test helpers: temp directories, a runner over the real definition (engine
 * tasks run in this process unless a test asks for the real worker), and
 * generated PDFs. Library-backed tests skip without `npm install`.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";
import { runEngineTask } from "../lib/pdf-engine.mjs";

export const AS_TOOL = { source: "tool" };
export const pdfLib = await import("pdf-lib").catch(() => null);
const pdfjsAvailable = await import("pdfjs-dist/legacy/build/pdf.mjs").then(() => true, () => false);
export const SKIP_WITHOUT_LIBRARIES = pdfLib && pdfjsAvailable ? false : "pdf-lib/pdfjs-dist are not installed (run npm install in pdf-tools)";

/**
 * Creates temp directories and an operation runner for them.
 *
 * @param options - `{environment, runTask}`; runTask defaults to the engine in this process (object)
 * @param work - `async ({runOperation, inputDirectory, outputDirectory, outsideDirectory}) => void` (function)
 * @returns Promise of work's result
 */
export async function withPdfRunner({ environment = {}, runTask = (task, payload) => runEngineTask(task, payload) } = {}, work) {
  const baseDirectory = await realpath(await mkdtemp(join(tmpdir(), "graphrt-pdf-test-")));
  const directories = { inputDirectory: join(baseDirectory, "in"), outputDirectory: join(baseDirectory, "out"), outsideDirectory: join(baseDirectory, "outside") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const runOperation = createOperationRunner(createPluginDefinition({ runTask }), {
    PDF_TOOLS_INPUT_DIRS: directories.inputDirectory,
    PDF_TOOLS_OUTPUT_DIR: directories.outputDirectory,
    ...environment,
  });
  try {
    return await work({ runOperation, ...directories });
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
}

/**
 * Writes a PDF whose page N says "Page N of <label>".
 *
 * @param filePath - Where to write (string)
 * @param options - `{pageCount, label, title}` (object, optional)
 */
export async function writeTestPdf(filePath, { pageCount = 3, label = "doc", title = "Test document" } = {}) {
  const document = await pdfLib.PDFDocument.create();
  const font = await document.embedFont(pdfLib.StandardFonts.Helvetica);
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    document.addPage([300, 200]).drawText(`Page ${pageNumber} of ${label}`, { x: 20, y: 100, size: 16, font });
  }
  document.setTitle(title);
  document.setAuthor("graphrt tests");
  await writeFile(filePath, await document.save());
}

/**
 * Builds a one-page PDF whose content stream is a Flate bomb: `decodedMegabytes` of spaces deflated to
 * well under 1% (the reviewer's review6/mkbomb.mjs, inlined).
 *
 * @param decodedMegabytes - Inflated size of the content stream (number)
 * @returns PDF bytes (Buffer)
 */
export function buildFlateBombPdf(decodedMegabytes) {
  const compressed = deflateSync(Buffer.alloc(decodedMegabytes * 1024 * 1024, 0x20), { level: 9 });
  const parts = [];
  const offsets = [];
  let offset = 0;
  const push = (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "latin1");
    parts.push(bytes);
    offset += bytes.length;
  };
  push("%PDF-1.4\n");
  offsets[1] = offset;
  push("1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n");
  offsets[2] = offset;
  push("2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n");
  offsets[3] = offset;
  push("3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R>>endobj\n");
  offsets[4] = offset;
  push(`4 0 obj<</Length ${compressed.length}/Filter/FlateDecode>>stream\n`);
  push(compressed);
  push("\nendstream endobj\n");
  const xrefOffset = offset;
  const xrefRows = [1, 2, 3, 4].map((objectNumber) => `${String(offsets[objectNumber]).padStart(10, "0")} 00000 n \n`).join("");
  push(`xref\n0 5\n0000000000 65535 f \n${xrefRows}trailer<</Size 5/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/**
 * Reads the page texts of a PDF with the engine.
 *
 * @param bytes - PDF bytes (Uint8Array)
 * @returns Page texts (string[])
 */
export async function readPageTexts(bytes) {
  const { data } = await runEngineTask("extract_text", { bytes, maxChars: 100000, maxPages: 1000 });
  return data.pages.map((page) => page.text);
}
