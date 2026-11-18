/**
 * Parameter schemas shared by the Notion operation files.
 */
import { MAX_PAGE_SIZE } from "../lib/client.mjs";

export const LIMIT_PROPERTY = { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE, description: `Results per page (1-${MAX_PAGE_SIZE}, Notion's default is 100)` };
export const CURSOR_PROPERTY = { type: "string", description: "`next_cursor` from the previous page" };
export const PAGE_ID_PROPERTY = { type: "string", description: "Page id (with or without dashes) or the page's Notion URL" };
export const DATA_SOURCE_ID_PROPERTY = {
  type: "string",
  description: "Data source id (a database's table; from get_database `data_sources` or search with object_type data_source)",
};
export const DATABASE_ID_PROPERTY = {
  type: "string",
  description: "Database id or URL; used when the database has exactly one data source (otherwise pass data_source_id)",
};
export const VALUES_PROPERTY = {
  type: "object",
  description:
    'Simple {"Property name": value} map for title, rich_text, number (number or plain decimal string), select, multi_select (array or comma-separated string), status, date (ISO string or {start, end, time_zone}), checkbox, url, email, phone_number; null clears (a checkbox becomes false) and "" clears select, multi_select, url, email and phone_number',
};
export const RAW_PROPERTIES_PROPERTY = {
  type: "object",
  description: "Property values as Notion JSON (any type); wins over `values` for the same name. Agents may set people properties only when NOTION_TOOL_ALLOW_PEOPLE=1",
};

/**
 * Builds the `{start_cursor, page_size}` pagination fields Notion uses in bodies and queries.
 *
 * @param args - Validated arguments with optional `limit` and `cursor` (object)
 * @returns Pagination fields, undefined values omitted by the client (object)
 */
export function buildPagination(args) {
  return { start_cursor: args.cursor, page_size: args.limit };
}
