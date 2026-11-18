/**
 * Spreadsheet operations: metadata and sheet list, create a spreadsheet, add a sheet (tab).
 */
import { rejectInput, spreadsheetPath, withWriteOutcomeHint } from "../lib/client.mjs";

export const SPREADSHEET_ID_PROPERTY = {
  type: "string",
  description: "Spreadsheet id (the part of the URL between /d/ and /edit) or the full spreadsheet URL",
};
const METADATA_FIELDS =
  "spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),sheets.properties(sheetId,title,index,sheetType,hidden,gridProperties(rowCount,columnCount,frozenRowCount))";
const MAX_SHEET_TITLES = 50;

/**
 * Condenses a Spreadsheet resource to id, title, url and the sheet list.
 *
 * @param spreadsheet - Spreadsheet resource (object)
 * @returns `{spreadsheet_id, title, url, locale, time_zone, sheets}` (object)
 */
export function summarizeSpreadsheet(spreadsheet) {
  return {
    spreadsheet_id: spreadsheet?.spreadsheetId ?? null,
    title: spreadsheet?.properties?.title ?? null,
    url: spreadsheet?.spreadsheetUrl ?? null,
    locale: spreadsheet?.properties?.locale ?? null,
    time_zone: spreadsheet?.properties?.timeZone ?? null,
    sheets: (spreadsheet?.sheets ?? []).map((sheet) => summarizeSheetProperties(sheet.properties)),
  };
}

function summarizeSheetProperties(sheetProperties = {}) {
  return {
    sheet_id: sheetProperties.sheetId ?? 0,
    title: sheetProperties.title ?? null,
    index: sheetProperties.index ?? 0,
    sheet_type: sheetProperties.sheetType ?? "GRID",
    hidden: sheetProperties.hidden ?? false,
    row_count: sheetProperties.gridProperties?.rowCount ?? null,
    column_count: sheetProperties.gridProperties?.columnCount ?? null,
    frozen_row_count: sheetProperties.gridProperties?.frozenRowCount ?? 0,
  };
}

function buildCreateBody(args) {
  const sheetTitles = args.sheet_titles ?? [];
  if (new Set(sheetTitles).size !== sheetTitles.length) rejectInput("`sheet_titles` must not repeat a title");
  return {
    properties: { title: args.title, locale: args.locale, timeZone: args.time_zone },
    sheets: sheetTitles.length > 0 ? sheetTitles.map((sheetTitle) => ({ properties: { title: sheetTitle } })) : undefined,
  };
}

function buildAddSheetRequest(args) {
  const gridProperties = args.row_count || args.column_count ? { rowCount: args.row_count, columnCount: args.column_count } : undefined;
  return { requests: [{ addSheet: { properties: { title: args.title, index: args.index, gridProperties } } }] };
}

export const spreadsheetOperations = [
  {
    name: "get_spreadsheet",
    title: "Get Google spreadsheet",
    description: "Get a spreadsheet's title, URL, locale and its sheets (tabs) with ids and sizes.",
    parameters: { type: "object", properties: { spreadsheet_id: SPREADSHEET_ID_PROPERTY }, required: ["spreadsheet_id"] },
    run: async ({ client, args, signal }) => {
      const spreadsheet = await client.request({ path: spreadsheetPath(args.spreadsheet_id), query: { fields: METADATA_FIELDS }, signal });
      return { data: summarizeSpreadsheet(spreadsheet) };
    },
  },
  {
    name: "create_spreadsheet",
    title: "Create Google spreadsheet",
    description: "Create a new spreadsheet, optionally with named sheets. With a service account, the file belongs to the service account; share it to see it.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, description: "Spreadsheet title" },
        sheet_titles: { type: "array", items: { type: "string" }, maxItems: MAX_SHEET_TITLES, description: "Sheet (tab) titles; default one sheet named Sheet1" },
        locale: { type: "string", description: "Locale, e.g. id_ID or en_US (affects number and date parsing)" },
        time_zone: { type: "string", description: "Time zone, e.g. Asia/Jakarta" },
      },
      required: ["title"],
    },
    run: async ({ client, args, signal }) => {
      const pendingCreate = client.request({ method: "POST", path: "/spreadsheets", json: buildCreateBody(args), signal });
      const spreadsheet = await withWriteOutcomeHint(pendingCreate, `look for a spreadsheet titled ${JSON.stringify(args.title)} in Google Drive before creating another`);
      return { data: summarizeSpreadsheet(spreadsheet) };
    },
  },
  {
    name: "add_sheet",
    title: "Add sheet to Google spreadsheet",
    description: "Add a sheet (tab) to a spreadsheet. Fails with invalid_input if a sheet with that title exists.",
    parameters: {
      type: "object",
      properties: {
        spreadsheet_id: SPREADSHEET_ID_PROPERTY,
        title: { type: "string", minLength: 1, description: "New sheet title" },
        index: { type: "integer", minimum: 0, description: "Position among the tabs (0 = first); default last" },
        row_count: { type: "integer", minimum: 1, maximum: 1000000, description: "Rows (default 1000)" },
        column_count: { type: "integer", minimum: 1, maximum: 18278, description: "Columns (default 26)" },
      },
      required: ["spreadsheet_id", "title"],
    },
    run: async ({ client, args, signal }) => {
      const pendingAdd = client.request({ method: "POST", path: `${spreadsheetPath(args.spreadsheet_id)}:batchUpdate`, json: buildAddSheetRequest(args), signal });
      const batchResponse = await withWriteOutcomeHint(pendingAdd, "call get_spreadsheet and look for the sheet title");
      return { data: summarizeSheetProperties(batchResponse?.replies?.[0]?.addSheet?.properties) };
    },
  },
];
