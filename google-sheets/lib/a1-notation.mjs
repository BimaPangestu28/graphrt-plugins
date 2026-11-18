/**
 * A1 notation helpers: quote sheet names, build and loosely validate ranges.
 *
 * A sheet name is always wrapped in single quotes with inner apostrophes
 * doubled (`Jon's Data` -> `'Jon''s Data'`), which Sheets accepts for every
 * name, including names that look like cell references ("A1", "R1C1").
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const CELL_PART_PATTERN = /^\$?[A-Za-z]{0,3}\$?\d*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_SHEET_NAME_LENGTH = 100;

/**
 * Quotes a sheet name for A1 notation.
 *
 * @param sheetName - Sheet (tab) title (string)
 * @returns Quoted name (string)
 * @throws PluginError kind `invalid_input` - When the name is empty, too long or has control characters
 *
 * @example
 * quoteSheetName("Jon's Data"); // "'Jon''s Data'"
 */
export function quoteSheetName(sheetName) {
  if (typeof sheetName !== "string" || sheetName === "" || sheetName.length > MAX_SHEET_NAME_LENGTH || CONTROL_CHARACTER_PATTERN.test(sheetName)) {
    rejectRange(`Invalid sheet name ${JSON.stringify(sheetName)}: use 1-${MAX_SHEET_NAME_LENGTH} characters without control characters`);
  }
  return `'${sheetName.replaceAll("'", "''")}'`;
}

/**
 * Builds the A1 range sent to the API from a sheet name and/or a range.
 *
 * - `sheet` + `range` ("A1:C10"): `'Sheet'!A1:C10`; `range` must not name a sheet then.
 * - `sheet` only: the whole sheet, `'Sheet'`.
 * - `range` only: used as given, after a loose check; an unquoted sheet name before "!" is quoted.
 *
 * @param options - `{sheet, range}`, at least one set (object)
 * @returns A1 range (string)
 * @throws PluginError kind `invalid_input` - When the parts are missing or malformed
 *
 * @example
 * buildA1Range({ sheet: "My Sheet", range: "A1:C" }); // "'My Sheet'!A1:C"
 * buildA1Range({ range: "My Sheet!B2" });             // "'My Sheet'!B2"
 */
export function buildA1Range({ sheet, range }) {
  if (sheet === undefined && range === undefined) rejectRange("Pass `sheet`, `range`, or both");
  if (sheet !== undefined && range === undefined) return quoteSheetName(sheet);
  rejectControlCharacters(range);
  if (sheet !== undefined) {
    if (range.includes("!")) rejectRange("`range` must not name a sheet when `sheet` is set; pass cells only, e.g. \"A1:C10\"");
    return `${quoteSheetName(sheet)}!${validateCells(range)}`;
  }
  return normalizeQualifiedRange(range);
}

function normalizeQualifiedRange(range) {
  if (range.startsWith("'")) return normalizeQuotedRange(range);
  const separatorIndex = range.lastIndexOf("!");
  if (separatorIndex === -1) return range;
  return `${quoteSheetName(range.slice(0, separatorIndex))}!${validateCells(range.slice(separatorIndex + 1))}`;
}

// `'It''s'!A1`: find the closing quote that is not part of a doubled pair.
function normalizeQuotedRange(range) {
  const quotedNameMatch = /^'((?:[^']|'')+)'(?:!(.*))?$/s.exec(range);
  if (!quotedNameMatch) rejectRange(`Malformed range ${JSON.stringify(range)}: quote the sheet name as 'Name' and double inner apostrophes ('Jon''s')`);
  const sheetName = quotedNameMatch[1].replaceAll("''", "'");
  const cells = quotedNameMatch[2];
  return cells === undefined ? quoteSheetName(sheetName) : `${quoteSheetName(sheetName)}!${validateCells(cells)}`;
}

function validateCells(cells) {
  const parts = cells.split(":");
  const isValid = cells !== "" && parts.length <= 2 && parts.every((part) => part !== "" && CELL_PART_PATTERN.test(part));
  if (!isValid) rejectRange(`Malformed cell range ${JSON.stringify(cells)}: use A1 notation such as "A1", "A1:C10", "A:C" or "2:5"`);
  return cells;
}

function rejectControlCharacters(range) {
  if (CONTROL_CHARACTER_PATTERN.test(range)) rejectRange("`range` must not contain control characters");
}

function rejectRange(message) {
  throw new PluginError(message, { kind: "invalid_input" });
}

/**
 * Converts a zero-based column index to its A1 letters.
 *
 * @param columnIndex - 0 for A, 25 for Z, 26 for AA (number)
 * @returns Column letters (string)
 *
 * @example
 * columnLetters(27); // "AB"
 */
export function columnLetters(columnIndex) {
  let remaining = columnIndex + 1;
  let letters = "";
  while (remaining > 0) {
    const letterOffset = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + letterOffset) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}
