/**
 * `search_files`: builds Drive's `q` from plain fields (https://developers.google.com/workspace/drive/api/guides/search-files),
 * escaping every value, so callers (agents especially) never write query syntax and a value cannot change the
 * query's meaning. `list_files` still takes a raw `q` for anything else.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
// RFC 3339 date-time: the time with seconds is required; Drive reads a missing offset as UTC.
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * Quotes a value as a Drive query string literal.
 *
 * @param value - Raw value (string)
 * @returns `'...'` with backslashes and single quotes escaped (string)
 *
 * @example
 * quoteDriveValue("Q3 'final'"); // "'Q3 \\'final\\''"
 */
export function quoteDriveValue(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Builds the `q` expression for search_files.
 *
 * @param fields - `{name_contains, full_text, mime_type, folder_id, modified_after, include_trashed}` (object)
 * @returns Query, e.g. "name contains 'report' and trashed = false" (string)
 * @throws PluginError kind `invalid_input` - A folder id or date that is not well formed
 */
export function buildDriveQuery(fields) {
  const clauses = [];
  if (fields.name_contains) clauses.push(`name contains ${quoteDriveValue(fields.name_contains)}`);
  if (fields.full_text) clauses.push(`fullText contains ${quoteDriveValue(fields.full_text)}`);
  if (fields.mime_type) clauses.push(`mimeType = ${quoteDriveValue(fields.mime_type)}`);
  if (fields.folder_id) {
    if (!DRIVE_ID_PATTERN.test(fields.folder_id)) throw new PluginError("`folder_id` must be a Drive id (letters, digits, - and _)", { kind: "invalid_input" });
    clauses.push(`${quoteDriveValue(fields.folder_id)} in parents`);
  }
  if (fields.modified_after) {
    if (!RFC3339_PATTERN.test(fields.modified_after)) throw new PluginError("`modified_after` must be an RFC 3339 date-time with seconds, e.g. 2026-11-01T00:00:00Z", { kind: "invalid_input" });
    clauses.push(`modifiedTime > ${quoteDriveValue(fields.modified_after)}`);
  }
  if (!fields.include_trashed) clauses.push("trashed = false");
  return clauses.join(" and ");
}

const SEARCH_FIELD_NAMES = ["name_contains", "full_text", "mime_type", "folder_id", "modified_after", "include_trashed"];

/**
 * Wraps the declarative search_files operation (raw `q`) with plain fields.
 *
 * @param operation - Generated operation with a `q` query param (object)
 * @returns Operation taking the plain fields plus its other params (object)
 */
export function wrapSearchFiles(operation) {
  const { q: _rawQuery, ...otherProperties } = operation.parameters.properties;
  const properties = {
    name_contains: { type: "string", description: "Words in the file name" },
    full_text: { type: "string", description: "Words in the name, description or content" },
    mime_type: { type: "string", description: "Exact type, e.g. application/pdf or application/vnd.google-apps.folder" },
    folder_id: { type: "string", description: "Only direct children of this folder" },
    modified_after: { type: "string", description: "RFC 3339 date-time, e.g. 2026-11-01T00:00:00Z (a date alone is refused)" },
    include_trashed: { type: "boolean", default: false },
    ...otherProperties,
  };
  return {
    ...operation,
    parameters: { type: "object", properties, required: [] },
    run: (context) => {
      const passThrough = Object.fromEntries(Object.entries(context.args).filter(([argName]) => !SEARCH_FIELD_NAMES.includes(argName)));
      return operation.run({ ...context, args: { ...passThrough, q: buildDriveQuery(context.args) } });
    },
  };
}
