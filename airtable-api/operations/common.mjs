/**
 * Parameter schemas and record-list validation shared by the Airtable operation files.
 */
import { MAX_RECORDS_PER_WRITE, rejectInput, validateRecordId } from "../lib/client.mjs";

export const BASE_ID_PROPERTY = { type: "string", description: 'Base id ("app..."); defaults to AIRTABLE_BASE_ID' };
export const TABLE_PROPERTY = { type: "string", description: 'Table name or id ("tbl..."; ids survive renames)' };
export const CURSOR_PROPERTY = { type: "string", description: "`next_cursor` (Airtable offset) from the previous page" };
export const TYPECAST_PROPERTY = {
  type: "boolean",
  default: false,
  description: "Let Airtable convert strings to the field type (e.g. create missing select options). Workflow nodes only: agent tool calls always send false",
};

/**
 * Returns the typecast flag to send: as given for workflow nodes, always false for agent tools (typecast can
 * create select options and change data in ways an agent should not decide).
 *
 * @param context - `{args, source}` (object)
 * @returns Typecast flag (boolean)
 */
export function resolveTypecast({ args, source }) {
  return source === "tool" ? false : args.typecast;
}

/**
 * Checks upsert merge fields and the records against them: names are de-duplicated, and every record must have a
 * non-empty value for every merge field (an empty one would match or create the wrong record).
 *
 * @param fieldNames - fields_to_merge_on (string[])
 * @param records - Validated write records `{fields}` (Array<object>)
 * @returns De-duplicated merge field names (string[])
 * @throws PluginError kind `invalid_input` - No merge fields, or a record without a value for one
 */
export function validateMergeFields(fieldNames, records) {
  const uniqueNames = [...new Set(fieldNames)];
  if (uniqueNames.length === 0) rejectInput("`fields_to_merge_on` needs 1-3 field names");
  records.forEach((record, index) => {
    const missingName = uniqueNames.find((fieldName) => isEmptyMergeValue(record.fields[fieldName]));
    if (missingName !== undefined) rejectInput(`\`records[${index}]\` needs a non-empty value for merge field ${JSON.stringify(missingName)}`);
  });
  return uniqueNames;
}

function isEmptyMergeValue(fieldValue) {
  if (fieldValue === undefined || fieldValue === null) return true;
  if (typeof fieldValue === "string") return fieldValue.trim() === "";
  return Array.isArray(fieldValue) && fieldValue.length === 0;
}

/**
 * Checks a list of records for a write: 1-10 objects with a `fields` object, and an `id` when required.
 *
 * @param records - Records from the arguments (Array)
 * @param idRule - "required", "optional" or "forbidden" (string)
 * @returns Records as sent to Airtable, `{id?, fields}` (Array<object>)
 * @throws PluginError kind `invalid_input` - Empty, over 10, or a malformed record
 */
export function validateWriteRecords(records, idRule) {
  if (records.length === 0 || records.length > MAX_RECORDS_PER_WRITE) {
    rejectInput(`\`records\` must have 1-${MAX_RECORDS_PER_WRITE} items (Airtable's limit per request); got ${records.length}`);
  }
  return records.map((record, index) => validateWriteRecord(record, index, idRule));
}

function validateWriteRecord(record, index, idRule) {
  const label = `records[${index}]`;
  if (!record || typeof record !== "object" || Array.isArray(record)) rejectInput(`\`${label}\` must be an object {fields: {...}}`);
  if (!record.fields || typeof record.fields !== "object" || Array.isArray(record.fields)) rejectInput(`\`${label}.fields\` must be an object of field values`);
  const hasId = record.id !== undefined && record.id !== null && record.id !== "";
  if (idRule === "required" && !hasId) rejectInput(`\`${label}.id\` is required`);
  if (idRule === "forbidden" && hasId) rejectInput(`\`${label}\` must not have an id when creating records`);
  return hasId ? { id: validateRecordId(record.id), fields: record.fields } : { fields: record.fields };
}

/**
 * Builds a write records schema property.
 *
 * @param description - Property description (string)
 * @returns Schema (object)
 */
export function buildRecordsProperty(description) {
  return { type: "array", items: { type: "object" }, maxItems: MAX_RECORDS_PER_WRITE, description };
}
