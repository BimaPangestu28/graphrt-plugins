/**
 * Reading and writing CSV (csv-parse/csv-stringify) and XLSX (exceljs) as
 * arrays of rows. The libraries are loaded lazily so the plugin starts and
 * reports setup_required without node_modules.
 *
 * Reads run inside the table worker process (table-worker.mjs) and stay
 * within a cell budget (`{maxColumns, maxCells, maxBytes}`): only cells that
 * exist are visited (a lone cell at XFD1 must not make every row 16384 wide),
 * records are cut to maxColumns while parsing, and rows stop being collected
 * once the budget is spent (the result says `truncated`).
 */
import { classifyImportError, invalidInput } from "./errors.mjs";
import { escapeFormulaTrigger, fitRowsToBudget, parseA1Range, toPlainCellValue } from "./table-values.mjs";

const DELIMITER_CANDIDATES = [",", ";", "\t", "|"];
const MAX_CSV_RECORD_BYTES = 1_000_000;
const SHEET_NAME_PATTERN = /^[^[\]:*?/\\]{1,31}$/;

/** Thrown from csv-parse's on_record to stop parsing once the cell budget is spent. */
class BudgetSpent extends Error {}

async function importPackage(packageName, specifier = packageName) {
  return import(specifier).catch((importError) => {
    throw classifyImportError(packageName, "excel-csv", importError);
  });
}

async function loadExcel() {
  return (await importPackage("exceljs")).default;
}

/**
 * Guesses the delimiter from the first line: the candidate that appears most often outside quotes.
 *
 * @param text - CSV text (string)
 * @returns One of , ; tab | (string)
 */
export function detectDelimiter(text) {
  const firstLine = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0].replace(/"[^"]*"/g, "");
  const counts = DELIMITER_CANDIDATES.map((candidate) => firstLine.split(candidate).length - 1);
  const bestIndex = counts.indexOf(Math.max(...counts));
  return counts[bestIndex] > 0 ? DELIMITER_CANDIDATES[bestIndex] : ",";
}

/**
 * Parses CSV bytes into rows of strings within the cell budget.
 *
 * @param bytes - File contents (Buffer)
 * @param options - `{delimiter, maxRecords, budget}`; delimiter "auto" detects it; budget is `{maxColumns, maxCells, maxBytes}` (object)
 * @returns `{rawRows, delimiter, truncated}` (object)
 * @throws PluginError kind `invalid_input` - When the CSV cannot be parsed
 */
export async function readCsvRows(bytes, { delimiter = "auto", maxRecords, budget }) {
  const { parse } = await importPackage("csv-parse", "csv-parse/sync");
  const text = bytes.toString("utf8");
  const chosenDelimiter = delimiter === "auto" ? detectDelimiter(text) : delimiter;
  const collected = { rows: [], cells: 0, isCut: false };
  const keepRecord = (record) => {
    if (record.length > budget.maxColumns) collected.isCut = true;
    collected.rows.push(record.length > budget.maxColumns ? record.slice(0, budget.maxColumns) : record);
    collected.cells += Math.min(record.length, budget.maxColumns);
    if (collected.cells > budget.maxCells) throw new BudgetSpent();
    return null;
  };
  try {
    parse(text, { delimiter: chosenDelimiter, bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, to: maxRecords, max_record_size: MAX_CSV_RECORD_BYTES, on_record: keepRecord });
  } catch (parseError) {
    if (!(parseError instanceof BudgetSpent || parseError?.cause instanceof BudgetSpent)) throw invalidInput(`The CSV could not be parsed: ${parseError.message}`);
    collected.isCut = true;
  }
  const fitted = fitRowsToBudget(collected.rows, budget);
  return { rawRows: fitted.rows, delimiter: chosenDelimiter, truncated: fitted.truncated || collected.isCut };
}

async function loadWorkbook(bytes) {
  const Excel = await loadExcel();
  const workbook = new Excel.Workbook();
  await workbook.xlsx.load(bytes).catch((loadError) => {
    throw invalidInput(`The file is not a readable .xlsx workbook: ${loadError.message}`);
  });
  return workbook;
}

/**
 * Lists a workbook's sheets.
 *
 * @param bytes - .xlsx contents (Buffer)
 * @returns `[{name, index, state, row_count, column_count}]` (object[])
 */
export async function listWorkbookSheets(bytes) {
  const workbook = await loadWorkbook(bytes);
  return workbook.worksheets.map((worksheet, index) => ({ name: worksheet.name, index: index + 1, state: worksheet.state ?? "visible", row_count: worksheet.actualRowCount, column_count: worksheet.actualColumnCount }));
}

/**
 * Reads cell values of one sheet (formulas as their cached results), visiting only cells that exist.
 *
 * @param bytes - .xlsx contents (Buffer)
 * @param options - `{sheet, range, maxRecords, budget}`; sheet is a name or 1-based index, default the first;
 *   budget is `{maxColumns, maxCells, maxBytes}` (object)
 * @returns `{sheetName, rawRows, truncated}` (object)
 * @throws PluginError kind `invalid_input` - When the sheet does not exist
 */
export async function readXlsxRows(bytes, { sheet, range, maxRecords, budget }) {
  const workbook = await loadWorkbook(bytes);
  const worksheet = pickWorksheet(workbook, sheet);
  const bounds = range ? parseA1Range(range) : { firstRow: 1, lastRow: Number.MAX_SAFE_INTEGER, firstColumn: 1, lastColumn: Number.MAX_SAFE_INTEGER };
  const lastRow = Math.min(bounds.lastRow, bounds.firstRow + maxRecords - 1);
  const lastColumn = Math.min(bounds.lastColumn, bounds.firstColumn + budget.maxColumns - 1);
  const collected = collectExistingCells(worksheet, { ...bounds, lastRow, lastColumn }, budget);
  const fitted = fitRowsToBudget(trimTrailingEmptyRows(collected.rows), budget);
  const isColumnCut = bounds.lastColumn > lastColumn && collected.hasCellsBeyondColumns;
  return { sheetName: worksheet.name, rawRows: fitted.rows, truncated: fitted.truncated || collected.isCut || isColumnCut };
}

// Rows and cells that exist only; gaps between rows become empty rows, so row positions are kept.
function collectExistingCells(worksheet, bounds, budget) {
  const collected = { rows: [], cells: 0, isCut: false, hasCellsBeyondColumns: false };
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (collected.isCut || rowNumber < bounds.firstRow || rowNumber > bounds.lastRow) return;
    while (collected.rows.length < rowNumber - bounds.firstRow) collected.rows.push([]);
    const values = [];
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      if (columnNumber < bounds.firstColumn) return;
      if (columnNumber > bounds.lastColumn) {
        collected.hasCellsBeyondColumns = true;
        return;
      }
      values[columnNumber - bounds.firstColumn] = toPlainCellValue(cell.value);
    });
    // A row costs its padded width (up to its last cell), which is what it becomes in the result.
    collected.cells += Math.max(1, values.length);
    if (collected.cells > budget.maxCells) {
      collected.isCut = true;
      return;
    }
    collected.rows.push(Array.from(values, (value) => value ?? null));
  });
  return collected;
}

function pickWorksheet(workbook, sheet) {
  if (workbook.worksheets.length === 0) throw invalidInput("The workbook has no sheets");
  if (sheet === undefined) return workbook.worksheets[0];
  const byName = workbook.worksheets.find((worksheet) => worksheet.name === sheet);
  const byIndex = /^\d+$/.test(sheet) ? workbook.worksheets[Number(sheet) - 1] : undefined;
  const worksheet = byName ?? byIndex;
  if (!worksheet) throw invalidInput(`No sheet ${JSON.stringify(sheet)}; sheets: ${workbook.worksheets.map((candidate) => candidate.name).join(", ")}`);
  return worksheet;
}

function trimTrailingEmptyRows(rawRows) {
  let lastUsed = rawRows.length;
  while (lastUsed > 0 && rawRows[lastUsed - 1].every((value) => value === null || value === "")) lastUsed -= 1;
  return rawRows.slice(0, lastUsed);
}

/**
 * Writes rows as CSV, escaping formula triggers unless told not to.
 *
 * @param table - `{header, body}` from normalizeRowsForWriting (object)
 * @param options - `{delimiter, escapeFormulas}` (object)
 * @returns CSV bytes (Buffer)
 */
export async function writeCsvBytes({ header, body }, { delimiter = ",", escapeFormulas = true }) {
  const { stringify } = await importPackage("csv-stringify", "csv-stringify/sync");
  const prepare = (row) => row.map((value) => (escapeFormulas ? escapeFormulaTrigger(value) : value));
  const records = [...(header ? [header] : []), ...body].map(prepare);
  return Buffer.from(stringify(records, { delimiter, cast: { boolean: (value) => (value ? "true" : "false") } }), "utf8");
}

/**
 * Writes rows as a one-sheet .xlsx; every cell is a literal value (never a formula).
 *
 * @param table - `{header, body}` (object)
 * @param options - `{sheetName}` (object)
 * @returns .xlsx bytes (Buffer)
 * @throws PluginError kind `invalid_input` - When the sheet name is not allowed by Excel
 */
export async function writeXlsxBytes({ header, body }, { sheetName = "Sheet1" }) {
  if (!SHEET_NAME_PATTERN.test(sheetName)) throw invalidInput("`sheet_name` must be 1-31 characters without [ ] : * ? / \\");
  const Excel = await loadExcel();
  const workbook = new Excel.Workbook();
  const worksheet = workbook.addWorksheet(sheetName);
  if (header) worksheet.addRow(header).font = { bold: true };
  for (const row of body) worksheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
