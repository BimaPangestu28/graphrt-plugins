/**
 * Test helpers: temp directories, a runner over the real definition, and a
 * generated workbook. Library-backed tests skip without `npm install`.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

export const AS_NODE = { source: "node" };
export const AS_TOOL = { source: "tool" };
export const Excel = (await import("exceljs").catch(() => null))?.default ?? null;
const csvAvailable = await import("csv-parse/sync").then(() => true, () => false);
export const SKIP_WITHOUT_LIBRARIES = Excel && csvAvailable ? false : "exceljs/csv-parse are not installed (run npm install in excel-csv)";

/**
 * Creates temp directories and an operation runner for them.
 *
 * @param options - `{environment}` (object)
 * @param work - `async ({runOperation, inputDirectory, outputDirectory, outsideDirectory}) => void` (function)
 * @returns Promise of work's result
 */
export async function withTableRunner({ environment = {} } = {}, work) {
  const baseDirectory = await realpath(await mkdtemp(join(tmpdir(), "graphrt-table-test-")));
  const directories = { inputDirectory: join(baseDirectory, "in"), outputDirectory: join(baseDirectory, "out"), outsideDirectory: join(baseDirectory, "outside") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const runOperation = createOperationRunner(createPluginDefinition(), {
    EXCEL_CSV_INPUT_DIRS: directories.inputDirectory,
    EXCEL_CSV_OUTPUT_DIR: directories.outputDirectory,
    ...environment,
  });
  try {
    return await work({ runOperation, ...directories });
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
}

/**
 * Writes a workbook with a "Products" sheet (header, values, a formula, a date, rich text) and a hidden "Notes" sheet.
 *
 * @param filePath - Where to write (string)
 */
export async function writeTestWorkbook(filePath) {
  const workbook = new Excel.Workbook();
  const products = workbook.addWorksheet("Products");
  products.addRow(["name", "price", "qty", "total", "added"]);
  products.addRow(["kopi", 15000, 2, { formula: "B2*C2", result: 30000 }, new Date(Date.UTC(2026, 0, 2))]);
  products.addRow([{ richText: [{ text: "teh " }, { text: "manis", font: { bold: true } }] }, 8000, 3, { formula: "B3*C3", result: 24000 }, null]);
  const notes = workbook.addWorksheet("Notes");
  notes.state = "hidden";
  notes.addRow(["hello"]);
  await writeFile(filePath, Buffer.from(await workbook.xlsx.writeBuffer()));
}
