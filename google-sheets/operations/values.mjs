/**
 * Cell value operations: read one or many ranges, append rows, overwrite a range, clear a range.
 */
import { buildA1Range } from "../lib/a1-notation.mjs";
import { rejectInput, spreadsheetPath, valuesPath, withIdempotentRetry, withWriteOutcomeHint } from "../lib/client.mjs";
import { SPREADSHEET_ID_PROPERTY } from "./spreadsheets.mjs";

const MAX_ROWS_PER_WRITE = 10000;
const MAX_BATCH_RANGES = 100;

export const SHEET_PROPERTY = { type: "string", description: "Sheet (tab) title, quoted for you, e.g. My Sheet" };
const RANGE_PROPERTY = {
  type: "string",
  description: "A1 cells such as A1:C10, A:C or 2:5 (with `sheet`), or a full range like 'My Sheet'!A1:C10 or a named range",
};
export const VALUE_INPUT_OPTION_PROPERTY = {
  type: "string",
  enum: ["USER_ENTERED", "RAW"],
  default: "USER_ENTERED",
  description: "USER_ENTERED parses values like typed in the UI (numbers, dates, =formulas); RAW stores them as-is",
};
const ROWS_PROPERTY = {
  type: "array",
  items: { type: "array" },
  maxItems: MAX_ROWS_PER_WRITE,
  description: 'Rows of cell values, e.g. [["Name", "Qty"], ["Kopi", 2]]; cells are strings, numbers, booleans or null',
};
export const VALUE_RENDER_PROPERTIES = {
  value_render_option: {
    type: "string",
    enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"],
    default: "FORMATTED_VALUE",
    description: "FORMATTED_VALUE = as shown in the UI; UNFORMATTED_VALUE = raw numbers; FORMULA = formulas instead of results",
  },
  date_time_render_option: {
    type: "string",
    enum: ["SERIAL_NUMBER", "FORMATTED_STRING"],
    description: "How dates are returned when value_render_option is not FORMATTED_VALUE",
  },
};
const MAJOR_DIMENSION_PROPERTY = { type: "string", enum: ["ROWS", "COLUMNS"], default: "ROWS" };

/**
 * Checks that rows are a non-empty list of lists of scalar cells.
 *
 * @param rows - Candidate rows (Array)
 * @returns The rows, unchanged (Array<Array>)
 * @throws PluginError kind `invalid_input`
 */
export function validateRows(rows) {
  if (rows.length === 0) rejectInput("`rows` must contain at least one row");
  rows.forEach((row, rowIndex) =>
    row.forEach((cell, cellIndex) => {
      const isScalar = cell === null || ["string", "number", "boolean"].includes(typeof cell);
      if (!isScalar) rejectInput(`\`rows[${rowIndex}][${cellIndex}]\` must be a string, number, boolean or null`);
    }),
  );
  return rows;
}

function buildReadQuery(args) {
  return {
    majorDimension: args.major_dimension,
    valueRenderOption: args.value_render_option,
    dateTimeRenderOption: args.date_time_render_option,
  };
}

function toValueRange(valueRange) {
  return { range: valueRange?.range ?? null, major_dimension: valueRange?.majorDimension ?? "ROWS", values: valueRange?.values ?? [] };
}

/**
 * Appends a repeated query parameter (`name=a&name=b`) to a path; the shared client joins arrays with commas instead.
 *
 * @param path - API path without a query (string)
 * @param parameterName - Query name (string)
 * @param parameterValues - Values (string[])
 * @returns Path with the query string (string)
 */
export function appendRepeatedQuery(path, parameterName, parameterValues) {
  const queryString = new URLSearchParams(parameterValues.map((parameterValue) => [parameterName, parameterValue])).toString();
  return `${path}?${queryString}`;
}

async function appendRows({ client, args, signal }) {
  const a1Range = buildA1Range({ sheet: args.sheet, range: args.range ?? (args.sheet === undefined ? "A1" : undefined) });
  const query = { valueInputOption: args.value_input_option, insertDataOption: args.insert_data_option };
  const json = { majorDimension: "ROWS", values: validateRows(args.rows) };
  const pendingAppend = client.request({ method: "POST", path: valuesPath(args.spreadsheet_id, a1Range, "append"), query, json, signal });
  const appendResponse = await withWriteOutcomeHint(pendingAppend, `read the end of ${a1Range} with read_range to see whether the rows were added`);
  return { data: summarizeUpdate(appendResponse?.updates, appendResponse?.tableRange) };
}

/**
 * Builds the range to clear. A whole sheet is cleared only with an explicit `whole_sheet: true`, so a `range`
 * that rendered empty from a template (treated as missing) cannot wipe a sheet by accident.
 *
 * @param args - `{sheet, range, whole_sheet}` (object)
 * @returns A1 range (string)
 * @throws PluginError kind `invalid_input`
 */
export function buildClearRange(args) {
  const hasRange = args.range !== undefined && args.range !== "";
  if (args.whole_sheet === true) {
    if (hasRange) rejectInput("Pass either `range` or `whole_sheet: true`, not both");
    if (args.sheet === undefined) rejectInput("`whole_sheet: true` needs `sheet`");
    return buildA1Range({ sheet: args.sheet });
  }
  if (!hasRange) rejectInput("`range` is missing or empty; to clear the whole sheet pass `sheet` with `whole_sheet: true`");
  return buildA1Range(args);
}

async function clearRange({ client, args, signal }) {
  const a1Range = buildClearRange(args);
  const pendingClear = client.request({ method: "POST", path: valuesPath(args.spreadsheet_id, a1Range, "clear"), signal });
  const clearResponse = await withIdempotentRetry(pendingClear);
  return { data: { cleared_range: clearResponse?.clearedRange ?? a1Range } };
}

function summarizeUpdate(updateResponse, tableRange) {
  return {
    updated_range: updateResponse?.updatedRange ?? null,
    updated_rows: updateResponse?.updatedRows ?? 0,
    updated_columns: updateResponse?.updatedColumns ?? 0,
    updated_cells: updateResponse?.updatedCells ?? 0,
    ...(tableRange === undefined ? {} : { table_range: tableRange }),
  };
}

const RANGE_PARAMETERS = { spreadsheet_id: SPREADSHEET_ID_PROPERTY, sheet: SHEET_PROPERTY, range: RANGE_PROPERTY };

export const valueOperations = [
  {
    name: "read_range",
    title: "Read Google Sheets range",
    description: "Read cell values from a range, e.g. sheet \"Orders\" with range \"A1:D\". Empty trailing rows and cells are omitted.",
    parameters: {
      type: "object",
      properties: { ...RANGE_PARAMETERS, major_dimension: MAJOR_DIMENSION_PROPERTY, ...VALUE_RENDER_PROPERTIES },
      required: ["spreadsheet_id"],
    },
    run: async ({ client, args, signal }) => {
      const a1Range = buildA1Range(args);
      return { data: toValueRange(await client.request({ path: valuesPath(args.spreadsheet_id, a1Range), query: buildReadQuery(args), signal })) };
    },
  },
  {
    name: "batch_read",
    title: "Read several Google Sheets ranges",
    description: "Read several ranges in one call. Each range is a full A1 range ('Sheet'!A1:C) or, with `sheet`, cells of that sheet.",
    parameters: {
      type: "object",
      properties: {
        spreadsheet_id: SPREADSHEET_ID_PROPERTY,
        ranges: { type: "array", items: { type: "string" }, maxItems: MAX_BATCH_RANGES, description: "Ranges to read" },
        sheet: { ...SHEET_PROPERTY, description: "Sheet the ranges belong to (then ranges are cells only)" },
        major_dimension: MAJOR_DIMENSION_PROPERTY,
        ...VALUE_RENDER_PROPERTIES,
      },
      required: ["spreadsheet_id", "ranges"],
    },
    run: async ({ client, args, signal }) => {
      if (args.ranges.length === 0) rejectInput("`ranges` must contain at least one range");
      const a1Ranges = args.ranges.map((range) => buildA1Range({ sheet: args.sheet, range }));
      const path = appendRepeatedQuery(`${spreadsheetPath(args.spreadsheet_id)}/values:batchGet`, "ranges", a1Ranges);
      const batchResponse = await client.request({ path, query: buildReadQuery(args), signal });
      return { data: { value_ranges: (batchResponse?.valueRanges ?? []).map(toValueRange) } };
    },
  },
  {
    name: "append_rows",
    title: "Append rows to Google Sheet",
    description:
      "Append rows after the last row of the table at `range` (default: the whole sheet). Never retried after an unknown outcome: check with read_range first.",
    parameters: {
      type: "object",
      properties: {
        ...RANGE_PARAMETERS,
        rows: ROWS_PROPERTY,
        value_input_option: VALUE_INPUT_OPTION_PROPERTY,
        insert_data_option: {
          type: "string",
          enum: ["INSERT_ROWS", "OVERWRITE"],
          default: "INSERT_ROWS",
          description: "INSERT_ROWS inserts new rows; OVERWRITE writes into empty rows below the table",
        },
      },
      required: ["spreadsheet_id", "rows"],
    },
    run: appendRows,
  },
  {
    name: "update_range",
    title: "Update Google Sheets range",
    description: "Overwrite cells starting at the top-left of `range` with `rows`. Cells outside `rows` are left unchanged.",
    parameters: {
      type: "object",
      properties: { ...RANGE_PARAMETERS, rows: ROWS_PROPERTY, value_input_option: VALUE_INPUT_OPTION_PROPERTY },
      required: ["spreadsheet_id", "range", "rows"],
    },
    run: async ({ client, args, signal }) => {
      const a1Range = buildA1Range(args);
      const json = { majorDimension: "ROWS", values: validateRows(args.rows) };
      const updateResponse = await client.request({ method: "PUT", path: valuesPath(args.spreadsheet_id, a1Range), query: { valueInputOption: args.value_input_option }, json, signal });
      return { data: summarizeUpdate(updateResponse) };
    },
  },
  {
    name: "clear_range",
    title: "Clear Google Sheets range",
    description:
      "Clear the values (not the formatting) of `range`. To clear a whole sheet, pass `sheet` with `whole_sheet: true` (a missing or empty `range` is refused). Idempotent: safe to retry.",
    parameters: {
      type: "object",
      properties: {
        ...RANGE_PARAMETERS,
        whole_sheet: { type: "boolean", default: false, description: "Clear every cell of `sheet`; required instead of `range` to clear a whole sheet" },
      },
      required: ["spreadsheet_id"],
    },
    run: clearRange,
  },
];
