/**
 * Record operations: treat a sheet as a table whose first row is the header.
 *
 * `find_rows` filters rows client-side (equals / contains / ...); `upsert_row`
 * updates the first row whose key column matches, or appends a new row. Both
 * read the whole sheet, so they suit sheets up to tens of thousands of rows.
 */
import { buildA1Range, columnLetters } from "../lib/a1-notation.mjs";
import { rejectInput, spreadsheetPath, valuesPath, withWriteOutcomeHint } from "../lib/client.mjs";
import { SPREADSHEET_ID_PROPERTY } from "./spreadsheets.mjs";
import { SHEET_PROPERTY, VALUE_INPUT_OPTION_PROPERTY, VALUE_RENDER_PROPERTIES } from "./values.mjs";

const FILTER_OPERATORS = ["equals", "not_equals", "contains", "not_contains", "is_empty", "not_empty"];
const MAX_FILTERS = 20;
const MAX_FIND_LIMIT = 1000;

/**
 * Turns the header row into unique column names: blanks become the column letter, repeats get "_2", "_3".
 *
 * @param headerRow - First row of the sheet (Array)
 * @returns Column names in order (string[])
 *
 * @example
 * buildColumnNames(["Name", "", "Name"]); // ["Name", "B", "Name_2"]
 */
export function buildColumnNames(headerRow) {
  const seenCounts = new Map();
  return headerRow.map((headerCell, columnIndex) => {
    const baseName = String(headerCell ?? "").trim() || columnLetters(columnIndex);
    const seenCount = (seenCounts.get(baseName) ?? 0) + 1;
    seenCounts.set(baseName, seenCount);
    return seenCount === 1 ? baseName : `${baseName}_${seenCount}`;
  });
}

async function readSheetTable({ client, args, signal }, valueRenderOption) {
  const query = { majorDimension: "ROWS", valueRenderOption, dateTimeRenderOption: args.date_time_render_option };
  const valueRange = await client.request({ path: valuesPath(args.spreadsheet_id, buildA1Range({ sheet: args.sheet })), query, signal });
  const [headerRow = [], ...dataRows] = valueRange?.values ?? [];
  if (headerRow.length === 0) rejectInput(`Sheet ${JSON.stringify(args.sheet)} has no header row: put column names in row 1`);
  return { columnNames: buildColumnNames(headerRow), dataRows };
}

function toRecord(columnNames, row) {
  return Object.fromEntries(columnNames.map((columnName, columnIndex) => [columnName, row[columnIndex] ?? ""]));
}

function normalizeText(cellValue, isCaseSensitive) {
  const text = String(cellValue ?? "").trim();
  return isCaseSensitive ? text : text.toLowerCase();
}

function buildRowPredicate(filters, { columnNames, isCaseSensitive, matchMode }) {
  const checks = filters.map((filter) => buildFilterCheck(filter, columnNames, isCaseSensitive));
  if (checks.length === 0) return () => true;
  return (row) => (matchMode === "any" ? checks.some((check) => check(row)) : checks.every((check) => check(row)));
}

function buildFilterCheck(filter, columnNames, isCaseSensitive) {
  if (!filter || typeof filter !== "object") rejectInput("Each filter must be an object `{column, operator, value}`");
  const columnIndex = columnNames.indexOf(filter.column);
  if (columnIndex === -1) rejectInput(`Unknown filter column ${JSON.stringify(filter.column)}; columns are: ${columnNames.join(", ")}`);
  const operator = filter.operator ?? "equals";
  if (!FILTER_OPERATORS.includes(operator)) rejectInput(`Unknown filter operator ${JSON.stringify(operator)}; use one of ${FILTER_OPERATORS.join(", ")}`);
  const needsValue = !["is_empty", "not_empty"].includes(operator);
  if (needsValue && (filter.value === undefined || filter.value === null)) rejectInput(`Filter on ${JSON.stringify(filter.column)} with ${operator} needs a \`value\``);
  const expectedText = normalizeText(filter.value, isCaseSensitive);
  return (row) => compareCell(normalizeText(row[columnIndex], isCaseSensitive), operator, expectedText);
}

function compareCell(cellText, operator, expectedText) {
  const comparisons = {
    equals: () => cellText === expectedText,
    not_equals: () => cellText !== expectedText,
    contains: () => cellText.includes(expectedText),
    not_contains: () => !cellText.includes(expectedText),
    is_empty: () => cellText === "",
    not_empty: () => cellText !== "",
  };
  return comparisons[operator]();
}

function parseOffsetCursor(cursor) {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) rejectInput("`cursor` must be the next_cursor returned by a previous find_rows call");
  return Number(cursor);
}

async function findRows(context) {
  const { args } = context;
  if (args.filters.length > MAX_FILTERS) rejectInput(`At most ${MAX_FILTERS} filters are allowed`);
  const { columnNames, dataRows } = await readSheetTable(context, args.value_render_option);
  const matchesFilters = buildRowPredicate(args.filters, { columnNames, isCaseSensitive: args.case_sensitive, matchMode: args.match });
  const matchingRows = dataRows
    .map((row, dataIndex) => ({ row_number: dataIndex + 2, row }))
    .filter(({ row }) => matchesFilters(row));
  const offset = parseOffsetCursor(args.cursor);
  const pageRows = matchingRows.slice(offset, offset + args.limit);
  const nextOffset = offset + pageRows.length;
  return {
    data: pageRows.map(({ row_number: rowNumber, row }) => ({ row_number: rowNumber, record: toRecord(columnNames, row) })),
    next_cursor: nextOffset < matchingRows.length ? String(nextOffset) : null,
  };
}

function validateRecord(record, columnNames, keyColumn) {
  if (!columnNames.includes(keyColumn)) rejectInput(`Unknown key_column ${JSON.stringify(keyColumn)}; columns are: ${columnNames.join(", ")}`);
  const unknownColumns = Object.keys(record).filter((columnName) => !columnNames.includes(columnName));
  if (unknownColumns.length > 0) rejectInput(`Unknown record columns ${unknownColumns.join(", ")}; columns are: ${columnNames.join(", ")}`);
  const keyValue = record[keyColumn];
  if (keyValue === undefined || keyValue === null || String(keyValue).trim() === "") rejectInput(`\`record\` must set the key column ${JSON.stringify(keyColumn)}`);
  for (const [columnName, cellValue] of Object.entries(record)) {
    const isScalar = cellValue === null || ["string", "number", "boolean"].includes(typeof cellValue);
    if (!isScalar) rejectInput(`\`record.${columnName}\` must be a string, number, boolean or null`);
  }
}

/**
 * Returns the record's cells as written: the key cell is forced to text under USER_ENTERED (prefixed with `'`)
 * so keys like +6281234567890, 007 or 2026-11-18 are stored verbatim instead of parsed as numbers or dates.
 *
 * @param args - `{record, key_column, value_input_option}` (object)
 * @returns Cell values by column name (object)
 */
export function buildWrittenRecord(args) {
  const keyValue = args.record[args.key_column];
  const isTextKeyParsedByUi = args.value_input_option !== "RAW" && typeof keyValue === "string";
  return { ...args.record, [args.key_column]: isTextKeyParsedByUi ? `'${keyValue}` : keyValue };
}

async function updateMatchedRow({ client, args, signal }, { columnNames, rowNumber }) {
  const quotedSheet = buildA1Range({ sheet: args.sheet });
  const data = Object.entries(buildWrittenRecord(args)).map(([columnName, cellValue]) => ({
    range: `${quotedSheet}!${columnLetters(columnNames.indexOf(columnName))}${rowNumber}`,
    values: [[cellValue ?? ""]],
  }));
  const json = { valueInputOption: args.value_input_option, data };
  const pendingUpdate = client.request({ method: "POST", path: `${spreadsheetPath(args.spreadsheet_id)}/values:batchUpdate`, json, signal });
  const updateResponse = await withWriteOutcomeHint(pendingUpdate, `read row ${rowNumber} of ${quotedSheet} with read_range`);
  return { action: "updated", row_number: rowNumber, updated_cells: updateResponse?.totalUpdatedCells ?? data.length };
}

async function appendNewRow({ client, args, signal }, { columnNames }) {
  const lastUsedIndex = Math.max(...Object.keys(args.record).map((columnName) => columnNames.indexOf(columnName)));
  const writtenRecord = buildWrittenRecord(args);
  const row = columnNames.slice(0, lastUsedIndex + 1).map((columnName) => writtenRecord[columnName] ?? "");
  const a1Range = `${buildA1Range({ sheet: args.sheet })}!A1`;
  const query = { valueInputOption: args.value_input_option, insertDataOption: "INSERT_ROWS" };
  const pendingAppend = client.request({ method: "POST", path: valuesPath(args.spreadsheet_id, a1Range, "append"), query, json: { majorDimension: "ROWS", values: [row] }, signal });
  const keyText = JSON.stringify(String(args.record[args.key_column]));
  const appendResponse = await withWriteOutcomeHint(pendingAppend, `call find_rows with ${args.key_column} equals ${keyText} to see whether the row was added`);
  const updatedRange = appendResponse?.updates?.updatedRange ?? null;
  return { action: "inserted", row_number: parseFirstRowNumber(updatedRange), updated_range: updatedRange };
}

// The sheet name may itself contain "!", so the cells start after the last one.
function parseFirstRowNumber(updatedRange) {
  const cells = (updatedRange ?? "").slice((updatedRange ?? "").lastIndexOf("!") + 1);
  const rowMatch = /^\$?[A-Za-z]*\$?(\d+)/.exec(cells);
  return rowMatch ? Number(rowMatch[1]) : null;
}

// Unformatted key cells catch matches the formatted text hides, e.g. 1234 shown as "1,234".
async function readUnformattedKeyColumn({ client, args, signal }, keyIndex) {
  const keyLetters = columnLetters(keyIndex);
  const keyRange = `${buildA1Range({ sheet: args.sheet })}!${keyLetters}:${keyLetters}`;
  const query = { majorDimension: "ROWS", valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" };
  const valueRange = await client.request({ path: valuesPath(args.spreadsheet_id, keyRange), query, signal });
  return (valueRange?.values ?? []).slice(1).map((row) => row[0]);
}

async function findMatchingDataIndex(context, { dataRows, keyIndex }) {
  const keyText = normalizeText(context.args.record[context.args.key_column], true);
  const formattedIndex = dataRows.findIndex((row) => normalizeText(row[keyIndex], true) === keyText);
  const unformattedKeys = await readUnformattedKeyColumn(context, keyIndex);
  const unformattedIndex = unformattedKeys.findIndex((keyCell) => normalizeText(keyCell, true) === keyText);
  const matchIndexes = [formattedIndex, unformattedIndex].filter((matchIndex) => matchIndex !== -1);
  return matchIndexes.length === 0 ? -1 : Math.min(...matchIndexes);
}

async function upsertRow(context) {
  const { args } = context;
  if (Object.keys(args.record).length === 0) rejectInput("`record` must set at least the key column");
  const { columnNames, dataRows } = await readSheetTable(context, "FORMATTED_VALUE");
  validateRecord(args.record, columnNames, args.key_column);
  const matchIndex = await findMatchingDataIndex(context, { dataRows, keyIndex: columnNames.indexOf(args.key_column) });
  const result = matchIndex === -1 ? await appendNewRow(context, { columnNames }) : await updateMatchedRow(context, { columnNames, rowNumber: matchIndex + 2 });
  return { data: { ...result, key: args.record[args.key_column] } };
}

export const recordOperations = [
  {
    name: "find_rows",
    title: "Find rows in Google Sheet",
    description:
      "Find rows in a sheet whose first row is the header. Filters compare trimmed text: equals, not_equals, contains, not_contains, is_empty, not_empty. Returns {row_number, record}.",
    parameters: {
      type: "object",
      properties: {
        spreadsheet_id: SPREADSHEET_ID_PROPERTY,
        sheet: SHEET_PROPERTY,
        filters: {
          type: "array",
          items: { type: "object" },
          default: [],
          description: 'Filters `{column, operator, value}`, e.g. [{"column": "Status", "operator": "equals", "value": "new"}]; none = all rows',
        },
        match: { type: "string", enum: ["all", "any"], default: "all", description: "Rows must match all filters, or any" },
        case_sensitive: { type: "boolean", default: false },
        ...VALUE_RENDER_PROPERTIES,
        limit: { type: "integer", minimum: 1, maximum: MAX_FIND_LIMIT, default: 100, description: `Page size (max ${MAX_FIND_LIMIT})` },
        cursor: { type: "string", description: "next_cursor from a previous call (an offset into the matches)" },
      },
      required: ["spreadsheet_id", "sheet"],
    },
    run: findRows,
  },
  {
    name: "upsert_row",
    title: "Upsert row in Google Sheet",
    description:
      "Update the first row whose key column equals the record's key (formatted or unformatted value; only the record's columns change), or append the record as a new row. A text key is written verbatim. Not atomic: two concurrent upserts of a new key can both append, and rows inserted or deleted between the read and the write can shift the target row.",
    parameters: {
      type: "object",
      properties: {
        spreadsheet_id: SPREADSHEET_ID_PROPERTY,
        sheet: SHEET_PROPERTY,
        key_column: { type: "string", minLength: 1, description: "Header of the column that identifies a row, e.g. Order ID" },
        record: { type: "object", description: 'Values by header, e.g. {"Order ID": "A-1", "Status": "paid"}; null clears a cell' },
        value_input_option: VALUE_INPUT_OPTION_PROPERTY,
      },
      required: ["spreadsheet_id", "sheet", "key_column", "record"],
    },
    run: upsertRow,
  },
];
