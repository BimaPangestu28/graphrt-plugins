/**
 * excel-csv operations: list_sheets and read need only the input allowlist;
 * write and convert add new files to EXCEL_CSV_OUTPUT_DIR. CSV output is
 * protected against formula injection unless a workflow node turns it off.
 */
import { buildNameHint, OUTPUT_NAME_PARAMETER } from "../lib/file-access.mjs";
import { invalidInput, permissionDenied } from "../lib/errors.mjs";
import { normalizeRowsForWriting, shapeRows, typeNumericText } from "../lib/table-values.mjs";
import { writeCsvBytes, writeXlsxBytes } from "../lib/table-io.mjs";

const INPUT_PARAMETER = { type: "string", description: ".csv, .tsv, .txt or .xlsx file inside EXCEL_CSV_INPUT_DIRS (or EXCEL_CSV_OUTPUT_DIR); absolute, ~/..., or relative to the first input directory" };
const SHEET_PARAMETER = { type: "string", description: "XLSX sheet name or 1-based index (default: the first sheet)" };
const DELIMITER_PARAMETER = { type: "string", enum: ["auto", ",", ";", "\t", "|"], description: "CSV delimiter (reading default: auto-detect, tab for .tsv; writing default: ,)" };
const PROTECTION_PARAMETER = {
  type: "boolean",
  default: true,
  description: "Prefix CSV cells starting with = + - @ tab or CR with ' so spreadsheet apps do not run them as formulas. Only workflow nodes may turn this off",
};
const MAX_WRITE_COLUMNS = 1000;

const listSheetsOperation = {
  name: "list_sheets",
  title: "List sheets",
  description: "Lists an .xlsx workbook's sheets with their 1-based index, visibility and used row/column counts",
  parameters: { type: "object", properties: { input: INPUT_PARAMETER }, required: ["input"] },
  run: async ({ client, args, signal }) => ({ data: await client.listSheets(args.input, signal) }),
};

const readOperation = {
  name: "read",
  title: "Read a table",
  description: "Reads rows from a CSV/TSV file or an XLSX sheet (optionally an A1 range). Formula cells give their saved results, dates ISO strings. Rows come as objects keyed by the header row, or as arrays",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      sheet: SHEET_PARAMETER,
      range: { type: "string", description: "XLSX A1 range such as A1:F200 (default: the used area)" },
      header_row: { type: "integer", minimum: 0, maximum: 1000, default: 1, description: "Row (1-based, within the range) holding column names; 0 means none (columns become column_1, column_2, ...)" },
      max_rows: { type: "integer", minimum: 1, maximum: 1000000, default: 1000, description: "Most data rows returned (also capped by EXCEL_CSV_MAX_ROWS)" },
      delimiter: DELIMITER_PARAMETER,
      row_format: { type: "string", enum: ["objects", "arrays"], default: "objects", description: "Rows as objects keyed by column name, or as arrays" },
    },
    required: ["input"],
  },
  run: async ({ client, args, signal }) => {
    const maxRows = Math.min(args.max_rows, client.settings.maxRows);
    const table = await client.readTable({ input: args.input, sheet: args.sheet, range: args.range, delimiter: args.delimiter, maxRecords: args.header_row + maxRows + 1, signal });
    const shaped = shapeRows(table.rawRows, { headerRow: args.header_row, maxRows, rowShape: args.row_format });
    return { data: { path: table.path, format: table.kind, sheet: table.sheetName, delimiter: table.delimiter, ...shaped, truncated: shaped.truncated || table.truncated } };
  },
};

/**
 * Refuses turning CSV-injection protection off from a tool call.
 *
 * @param isProtected - The `csv_injection_protection` argument (boolean)
 * @param source - "node" or "tool" (string)
 * @throws PluginError kind `permission_denied` - When a tool (or unknown source) passes false
 */
export function assertProtectionChoiceAllowed(isProtected, source) {
  if (!isProtected && source !== "node") throw permissionDenied("`csv_injection_protection: false` is for workflow nodes only");
}

async function encodeTable(table, { format, delimiter, isProtected, sheetName }) {
  return format === "xlsx" ? writeXlsxBytes(table, { sheetName }) : writeCsvBytes(table, { delimiter: delimiter && delimiter !== "auto" ? delimiter : ",", escapeFormulas: isProtected });
}

const writeOperation = {
  name: "write",
  title: "Write a table",
  description: "Writes rows (objects or arrays) to a new CSV or XLSX file in EXCEL_CSV_OUTPUT_DIR. XLSX cells are always literal values, never formulas; CSV cells that look like formulas are neutralised",
  parameters: {
    type: "object",
    properties: {
      rows: { type: "array", maxItems: 1000000, description: "Rows: objects (keys become columns) or arrays of values" },
      columns: { type: "array", items: { type: "string" }, maxItems: MAX_WRITE_COLUMNS, description: "Column order and header row (default: the objects' keys; none for arrays)" },
      format: { type: "string", enum: ["csv", "xlsx"], default: "csv", description: "Output format" },
      sheet_name: { type: "string", default: "Sheet1", description: "XLSX sheet name" },
      delimiter: DELIMITER_PARAMETER,
      csv_injection_protection: PROTECTION_PARAMETER,
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["rows"],
  },
  run: async ({ client, args, source }) => {
    assertProtectionChoiceAllowed(args.csv_injection_protection, source);
    if (args.rows.length > client.settings.maxRows) throw invalidInput(`\`rows\` has ${args.rows.length} rows, over the limit of ${client.settings.maxRows} (EXCEL_CSV_MAX_ROWS)`);
    const table = normalizeRowsForWriting(args.rows, args.columns);
    if ((table.header?.length ?? 0) > MAX_WRITE_COLUMNS || table.body.some((row) => row.length > MAX_WRITE_COLUMNS)) throw invalidInput(`At most ${MAX_WRITE_COLUMNS} columns`);
    const bytes = await encodeTable(table, { format: args.format, delimiter: args.delimiter, isProtected: args.csv_injection_protection, sheetName: args.sheet_name });
    const outputFile = await client.fileAccess.writeOutputFile({ nameHint: buildNameHint(args.output_name ?? "table"), extension: args.format }, bytes);
    return { data: { ...outputFile, format: args.format, row_count: table.body.length } };
  },
};

const convertOperation = {
  name: "convert",
  title: "Convert CSV and XLSX",
  description: "Converts a CSV/TSV file to XLSX (decimal text becomes numbers unless keep_text) or an XLSX sheet to CSV; writes a new file",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      to: { type: "string", enum: ["csv", "xlsx"], description: "Target format" },
      sheet: SHEET_PARAMETER,
      sheet_name: { type: "string", default: "Sheet1", description: "Sheet name when writing XLSX" },
      delimiter: { ...DELIMITER_PARAMETER, description: "Delimiter of the CSV side: read from (default auto-detect) or written (default ,)" },
      keep_text: { type: "boolean", default: false, description: "CSV to XLSX: keep every cell as text" },
      csv_injection_protection: PROTECTION_PARAMETER,
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input", "to"],
  },
  run: async ({ client, args, signal, source }) => {
    assertProtectionChoiceAllowed(args.csv_injection_protection, source);
    const table = await client.readTable({ input: args.input, sheet: args.sheet, delimiter: args.delimiter, maxRecords: client.settings.maxRows + 1, signal });
    if (table.rawRows.length > client.settings.maxRows) throw invalidInput(`The input has more than ${client.settings.maxRows} rows (EXCEL_CSV_MAX_ROWS)`);
    if (table.truncated) throw invalidInput("The input is larger than the cell budget (EXCEL_CSV_MAX_COLUMNS, EXCEL_CSV_MAX_CELLS, EXCEL_CSV_MAX_RESULT_BYTES); nothing was converted"); 
    const body = args.to === "xlsx" && table.kind === "csv" && !args.keep_text ? table.rawRows.map((row) => row.map(typeNumericText)) : table.rawRows;
    const bytes = await encodeTable({ header: null, body }, { format: args.to, delimiter: table.kind === "xlsx" ? args.delimiter : undefined, isProtected: args.csv_injection_protection, sheetName: args.sheet_name });
    const outputFile = await client.fileAccess.writeOutputFile({ nameHint: buildNameHint(args.output_name, table.path), extension: args.to }, bytes);
    return { data: { ...outputFile, format: args.to, from: table.kind, sheet: table.sheetName, row_count: body.length } };
  },
};

export const tableOperations = [listSheetsOperation, readOperation, writeOperation, convertOperation];
