/**
 * Settings and the client one excel-csv call works with: allowlisted reads
 * of .csv/.tsv/.xlsx files (zip-bomb checked), table parsing in a killable
 * worker process under a memory budget and a cell budget, and new output
 * files in EXCEL_CSV_OUTPUT_DIR.
 */
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileAccess, fileAccessVariableNames, readFileAccessSettings } from "./file-access.mjs";
import { readInteger } from "./environment-readers.mjs";
import { assertZipWithinLimits } from "./zip-inspection.mjs";
import { createIsolatedTaskRunner } from "./isolated-task.mjs";
import { invalidInput } from "./errors.mjs";

export const ENVIRONMENT_PREFIX = "EXCEL_CSV";
export const FILE_VARIABLES = fileAccessVariableNames(ENVIRONMENT_PREFIX);
export const LIMIT_VARIABLES = [
  "EXCEL_CSV_MAX_ROWS", "EXCEL_CSV_MAX_UNZIPPED_BYTES", "EXCEL_CSV_MAX_COLUMNS", "EXCEL_CSV_MAX_CELLS",
  "EXCEL_CSV_MAX_RESULT_BYTES", "EXCEL_CSV_MAX_MEMORY_MB", "EXCEL_CSV_TIMEOUT_MS",
];
export const TABLE_EXTENSIONS = ["csv", "tsv", "txt", "xlsx"];
export const CALL_TIMEOUT_MS = 120000;
const MEBIBYTE = 1024 ** 2;
const MAX_ZIP_ENTRIES = 10000;
const WORKER_PATH = fileURLToPath(new URL("./table-worker.mjs", import.meta.url));

/**
 * Builds settings from environment variables.
 *
 * @param environment - Environment variables (object)
 * @returns `{files, maxRows, maxUnzippedBytes, budget: {maxColumns, maxCells, maxBytes}, maxMemoryMb, timeoutMs}` (object)
 * @throws PluginError kind `invalid_input` - When a variable has an invalid value
 */
export function readTableSettings(environment = {}) {
  return {
    files: readFileAccessSettings(environment, { prefix: ENVIRONMENT_PREFIX, defaultMaxInputBytes: 50 * MEBIBYTE, defaultMaxOutputBytes: 100 * MEBIBYTE, maxBytesCeiling: 1024 * MEBIBYTE }),
    maxRows: readInteger(environment, "EXCEL_CSV_MAX_ROWS", 100000, { minimum: 1, maximum: 1000000 }),
    maxUnzippedBytes: readInteger(environment, "EXCEL_CSV_MAX_UNZIPPED_BYTES", 300 * MEBIBYTE, { minimum: MEBIBYTE, maximum: 4096 * MEBIBYTE }),
    budget: {
      maxColumns: readInteger(environment, "EXCEL_CSV_MAX_COLUMNS", 1000, { minimum: 1, maximum: 16384 }),
      maxCells: readInteger(environment, "EXCEL_CSV_MAX_CELLS", 500_000, { minimum: 100, maximum: 50_000_000 }),
      maxBytes: readInteger(environment, "EXCEL_CSV_MAX_RESULT_BYTES", 50 * MEBIBYTE, { minimum: 1024, maximum: 1024 * MEBIBYTE }),
    },
    maxMemoryMb: readInteger(environment, "EXCEL_CSV_MAX_MEMORY_MB", 1024, { minimum: 128, maximum: 16384 }),
    timeoutMs: readInteger(environment, "EXCEL_CSV_TIMEOUT_MS", 60000, { minimum: 1000, maximum: CALL_TIMEOUT_MS - 20000 }),
  };
}

/**
 * Creates the client for one call.
 *
 * @param environment - Environment variables (object)
 * @param dependencies - `{runTask, fileAccessDependencies}` overrides for tests (object, optional)
 * @returns `{settings, fileAccess, readTable, listSheets}` (object)
 */
export function createTableClient(environment, dependencies = {}) {
  const settings = readTableSettings(environment);
  const fileAccess = createFileAccess(settings.files, dependencies.fileAccessDependencies);
  const launchTask = dependencies.runTask ?? createIsolatedTaskRunner({ workerPath: WORKER_PATH, displayName: "Table parsing", memoryVariable: "EXCEL_CSV_MAX_MEMORY_MB" });
  const runTask = (task, payload, signal) => launchTask(task, payload, { signal, timeoutMs: settings.timeoutMs, maxMemoryMb: settings.maxMemoryMb });
  const context = { settings, fileAccess, runTask };
  return { settings, fileAccess, readTable: (request) => readTable(context, request), listSheets: (rawPath, signal) => listSheets(context, rawPath, signal) };
}

/**
 * Tells the table kind of a path from its extension.
 *
 * @param filePath - Path (string)
 * @returns "xlsx" or "csv" (string)
 */
export function tableKindOf(filePath) {
  return extname(filePath).toLowerCase() === ".xlsx" ? "xlsx" : "csv";
}

async function readTableFile(context, rawPath) {
  const file = await context.fileAccess.readInputFile(rawPath, { extensions: TABLE_EXTENSIONS });
  const kind = tableKindOf(file.path);
  if (kind === "xlsx") assertZipWithinLimits(file.bytes, { maxUnzippedBytes: context.settings.maxUnzippedBytes, maxEntries: MAX_ZIP_ENTRIES });
  return { ...file, kind };
}

/**
 * Reads raw rows from a CSV/TSV or XLSX file in the worker process.
 *
 * @param context - Client context (object)
 * @param request - `{input, sheet, range, delimiter, maxRecords, signal}` (object)
 * @returns `{path, kind, sheetName, delimiter, rawRows, truncated}` (object)
 */
async function readTable(context, { input, sheet, range, delimiter, maxRecords, signal }) {
  const file = await readTableFile(context, input);
  if (file.kind === "csv" && (sheet !== undefined || range !== undefined)) throw invalidInput("`sheet` and `range` apply to .xlsx files only");
  const defaultDelimiter = extname(file.path).toLowerCase() === ".tsv" ? "\t" : "auto";
  const budget = context.settings.budget;
  const table = file.kind === "xlsx"
    ? await context.runTask("read_xlsx", { bytes: file.bytes, options: { sheet, range, maxRecords, budget } }, signal)
    : await context.runTask("read_csv", { bytes: file.bytes, options: { delimiter: delimiter ?? defaultDelimiter, maxRecords, budget } }, signal);
  return { path: file.path, kind: file.kind, sheetName: table.sheetName ?? null, delimiter: table.delimiter ?? null, rawRows: table.rawRows, truncated: Boolean(table.truncated) };
}

async function listSheets(context, rawPath, signal) {
  const file = await readTableFile(context, rawPath);
  if (file.kind !== "xlsx") throw invalidInput("`list_sheets` needs an .xlsx file");
  return { path: file.path, sheets: await context.runTask("list_sheets", { bytes: file.bytes }, signal) };
}
