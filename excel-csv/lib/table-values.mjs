/**
 * Pure helpers for tables: A1 ranges, exceljs cell values as plain JSON,
 * header names, rows as objects, CSV-injection escaping and number typing.
 */
import { invalidInput } from "./errors.mjs";

const CELL_PATTERN = /^([A-Z]{1,3})([1-9]\d{0,6})$/;
const MAX_COLUMN_NUMBER = 16384;
/** Leading characters that make spreadsheet apps treat a CSV cell as a formula (OWASP). */
const FORMULA_TRIGGERS = ["=", "+", "-", "@", "\t", "\r"];
/** A signed decimal such as "-5" or "+1.25" is a number to every spreadsheet app, never a formula. */
const PLAIN_NUMBER_PATTERN = /^[+-]?\d+(\.\d+)?$/;

/**
 * Parses an A1 range such as "B2:D20" (or a single cell "B2").
 *
 * @param rangeText - Range text (string)
 * @returns `{firstRow, lastRow, firstColumn, lastColumn}` 1-based, inclusive (object)
 * @throws PluginError kind `invalid_input` - When the range is malformed or reversed
 *
 * @example
 * parseA1Range("b2:d20"); // { firstRow: 2, lastRow: 20, firstColumn: 2, lastColumn: 4 }
 */
export function parseA1Range(rangeText) {
  const cells = String(rangeText).trim().toUpperCase().replaceAll("$", "").split(":");
  if (cells.length > 2) throw invalidInput(`\`range\` ${JSON.stringify(rangeText)} is not an A1 range like A1:D100`);
  const [firstCell, lastCell = firstCell] = cells;
  const first = parseCell(firstCell, rangeText);
  const last = parseCell(lastCell, rangeText);
  if (first.row > last.row || first.column > last.column) throw invalidInput(`\`range\` ${JSON.stringify(rangeText)} must go from the top-left to the bottom-right cell`);
  return { firstRow: first.row, lastRow: last.row, firstColumn: first.column, lastColumn: last.column };
}

function parseCell(cellText, rangeText) {
  const match = CELL_PATTERN.exec(cellText ?? "");
  if (!match) throw invalidInput(`\`range\` ${JSON.stringify(rangeText)} is not an A1 range like A1:D100`);
  const column = [...match[1]].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0);
  if (column > MAX_COLUMN_NUMBER) throw invalidInput(`\`range\` column ${match[1]} is beyond XFD`);
  return { row: Number(match[2]), column };
}

/**
 * Turns an exceljs cell value into plain JSON: formulas become their cached result, dates ISO strings.
 *
 * @param value - exceljs `cell.value` (unknown)
 * @returns string, number, boolean or null
 */
export function toPlainCellValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== "object") return value;
  if ("result" in value || "formula" in value || "sharedFormula" in value) return toPlainCellValue(value.result ?? null);
  if (Array.isArray(value.richText)) return value.richText.map((run) => run.text ?? "").join("");
  if ("text" in value) return toPlainCellValue(value.text);
  if ("error" in value) return String(value.error);
  return JSON.stringify(value);
}

/**
 * Builds unique, non-empty column names from a header row.
 *
 * @param headerCells - Header values (unknown[])
 * @param columnCount - Number of columns in the data (number)
 * @returns Names such as ["name", "price", "column_3", "name_2"] (string[])
 */
export function buildColumnNames(headerCells, columnCount) {
  const seenNames = new Map();
  return Array.from({ length: columnCount }, (_, index) => {
    const rawName = headerCells[index] === null || headerCells[index] === undefined ? "" : String(headerCells[index]).trim();
    const baseName = rawName || `column_${index + 1}`;
    const timesSeen = (seenNames.get(baseName) ?? 0) + 1;
    seenNames.set(baseName, timesSeen);
    return timesSeen === 1 ? baseName : `${baseName}_${timesSeen}`;
  });
}

/**
 * Shapes raw rows into the read result: header handling, row cap and output form.
 *
 * @param rawRows - Rows as arrays (unknown[][])
 * @param options - `{headerRow, maxRows, rowShape}`; headerRow is 1-based within rawRows, 0 for none; rowShape "objects" or "arrays" (object)
 * @returns `{columns, rows, row_count, truncated}` (object)
 */
export function shapeRows(rawRows, { headerRow, maxRows, rowShape }) {
  const columnCount = rawRows.reduce((widest, row) => Math.max(widest, row.length), 0);
  const columns = headerRow > 0 ? buildColumnNames(rawRows[headerRow - 1] ?? [], columnCount) : buildColumnNames([], columnCount);
  const dataRows = rawRows.slice(headerRow > 0 ? headerRow : 0);
  const keptRows = dataRows.slice(0, maxRows).map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? null));
  const rows = rowShape === "arrays" ? keptRows : keptRows.map((row) => Object.fromEntries(columns.map((name, index) => [name, row[index]])));
  return { columns, rows, row_count: rows.length, truncated: dataRows.length > maxRows };
}

/**
 * Pads rows to one width and keeps as many as fit the cell and byte budget.
 *
 * Every row ends up as wide as the widest one, so the budget is charged for
 * width × rows before anything is padded (a single 900k-field line must not
 * turn every row into 900k cells).
 *
 * @param rows - Rows as arrays, possibly of different lengths (unknown[][])
 * @param budget - `{maxColumns, maxCells, maxBytes}` (object)
 * @returns `{rows, truncated}` — rows padded with null to the common width (object)
 *
 * @example
 * fitRowsToBudget([["a"], ["b", "c"]], { maxColumns: 10, maxCells: 2, maxBytes: 1e6 }); // { rows: [["a", null]], truncated: true }
 */
export function fitRowsToBudget(rows, { maxColumns, maxCells, maxBytes }) {
  const widest = rows.reduce((width, row) => Math.max(width, row.length), 0);
  const width = Math.min(maxColumns, widest);
  const rowLimit = width === 0 ? rows.length : Math.floor(maxCells / width);
  const fitted = [];
  let usedBytes = 0;
  let isTruncated = widest > maxColumns || rows.length > rowLimit;
  for (const row of rows.slice(0, rowLimit)) {
    const padded = Array.from({ length: width }, (_, index) => row[index] ?? null);
    usedBytes += padded.reduce((total, value) => total + (typeof value === "string" ? value.length + 3 : 8), 0);
    if (usedBytes > maxBytes) {
      isTruncated = true;
      break;
    }
    fitted.push(padded);
  }
  return { rows: fitted, truncated: isTruncated };
}

/**
 * Neutralises a CSV cell that a spreadsheet app would run as a formula, by prefixing an apostrophe.
 *
 * @param value - Cell value (unknown)
 * @returns The value, with `'` prepended to strings that start with = + - @ tab or CR (unknown)
 *
 * @example
 * escapeFormulaTrigger("=HYPERLINK(\"http://x\")"); // "'=HYPERLINK(\"http://x\")"
 */
export function escapeFormulaTrigger(value) {
  if (typeof value !== "string" || PLAIN_NUMBER_PATTERN.test(value)) return value;
  return FORMULA_TRIGGERS.some((trigger) => value.startsWith(trigger)) ? `'${value}` : value;
}

/**
 * Converts plain decimal text to a number (leading zeros, like "007", stay text).
 *
 * @param value - Cell text (unknown)
 * @returns A number or the original value (unknown)
 */
export function typeNumericText(value) {
  if (typeof value !== "string" || !/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(value.trim())) return value;
  return Number(value.trim());
}

/**
 * Normalises rows to write: objects or arrays in, arrays out, with the header row first.
 *
 * @param rows - Rows from the caller (object[] | unknown[][])
 * @param columns - Column order/header (string[], optional)
 * @returns `{header, body}` — header is null when rows are arrays and no columns were given (object)
 * @throws PluginError kind `invalid_input` - When rows mix shapes or a value is not a scalar
 */
export function normalizeRowsForWriting(rows, columns) {
  const isObjectRows = rows.every((row) => row !== null && typeof row === "object" && !Array.isArray(row));
  const isArrayRows = rows.every((row) => Array.isArray(row));
  if (!isObjectRows && !isArrayRows) throw invalidInput("`rows` must be all objects (one key per column) or all arrays");
  const header = columns ?? (isObjectRows ? [...new Set(rows.flatMap((row) => Object.keys(row)))] : null);
  const body = rows.map((row) => (isObjectRows ? header.map((name) => row[name]) : row).map(toWritableValue));
  return { header, body };
}

function toWritableValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return JSON.stringify(value);
}
