/**
 * Record operations on one table.
 *
 * Reads use the POST listRecords endpoint (JSON body, so arrays and long formulas need no URL encoding).
 * `create_records` is a POST and is never retried after an unknown outcome; `update_records` and
 * `upsert_records` set absolute values (upsert merges on fields), so they may be retried; `delete_records`
 * is node only.
 */
import { buildMatchFormula, MATCH_MODES } from "../lib/formula.mjs";
import { MAX_RECORDS_PER_WRITE, rejectInput, tablePath, validateRecordId, withWriteOutcomeHint } from "../lib/client.mjs";
import { pathSegment } from "../lib/shared/path.mjs";
import {
  BASE_ID_PROPERTY,
  buildRecordsProperty,
  CURSOR_PROPERTY,
  resolveTypecast,
  TABLE_PROPERTY,
  TYPECAST_PROPERTY,
  validateMergeFields,
  validateWriteRecords,
} from "./common.mjs";
import { deleteRecordsWithRetry } from "./delete.mjs";

const MAX_PAGE_SIZE = 100;
const SORT_DIRECTIONS = new Set(["asc", "desc"]);
const MAX_MERGE_FIELDS = 3;

const READ_PROPERTIES = {
  base_id: BASE_ID_PROPERTY,
  table: TABLE_PROPERTY,
  view: { type: "string", description: "View name or id: only its records, in its order unless `sort` is given" },
  fields: { type: "array", items: { type: "string" }, description: "Only return these fields (names or ids)" },
  limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE, description: `Records per page (1-${MAX_PAGE_SIZE}, default 100)` },
  max_records: { type: "integer", minimum: 1, description: "Stop after this many records in total, across pages" },
  return_fields_by_field_id: { type: "boolean", description: "Key `fields` by field id instead of name" },
  cursor: CURSOR_PROPERTY,
};

function validateSort(sort) {
  if (sort === undefined) return undefined;
  sort.forEach((sortItem, index) => {
    if (!sortItem || typeof sortItem.field !== "string" || sortItem.field === "") rejectInput(`\`sort[${index}].field\` is required`);
    if (sortItem.direction !== undefined && !SORT_DIRECTIONS.has(sortItem.direction)) rejectInput(`\`sort[${index}].direction\` must be "asc" or "desc"`);
  });
  return sort;
}

async function listRecordsPage(context, filterByFormula) {
  const { client, args, signal } = context;
  const json = {
    view: args.view,
    filterByFormula,
    sort: validateSort(args.sort),
    fields: args.fields,
    pageSize: args.limit,
    maxRecords: args.max_records,
    returnFieldsByFieldId: args.return_fields_by_field_id,
    offset: args.cursor,
  };
  const page = await client.request({ method: "POST", path: `${tablePath(context)}/listRecords`, json, signal, idempotent: true });
  return { page, next_cursor: page?.offset ?? null };
}

function sendRecordsWrite(context, method, json, options = {}) {
  const { client, signal } = context;
  return client.request({ method, path: tablePath(context), json, signal, ...options });
}

export const recordOperations = [
  {
    name: "list_records",
    title: "List records",
    description: "List records of an Airtable table, optionally filtered by an Airtable formula, sorted, limited to a view or fields; one page at a time.",
    parameters: {
      type: "object",
      properties: {
        ...READ_PROPERTIES,
        filter_by_formula: { type: "string", description: 'Airtable formula, e.g. AND({Status} = "Open", {Amount} > 100)' },
        sort: { type: "array", items: { type: "object" }, description: 'e.g. [{"field": "Created", "direction": "desc"}]' },
      },
      required: ["table"],
    },
    run: async (context) => {
      const { page, next_cursor } = await listRecordsPage(context, context.args.filter_by_formula);
      return { data: page, next_cursor };
    },
  },
  {
    name: "find_records",
    title: "Find records",
    description:
      'Find records whose fields equal (or contain) given values, e.g. where {"Email": "a@b.co"}. The formula is built with safe escaping; it is returned as `filter_by_formula`.',
    parameters: {
      type: "object",
      properties: {
        ...READ_PROPERTIES,
        where: {
          type: "object",
          description:
            'Conditions {"Field name": value}, all must match; value is text, a JSON number, a JSON boolean (true, not "true") or null (field is empty). No backslashes in names or values',
        },
        match: { type: "string", enum: MATCH_MODES, default: "exact", description: "How text values compare: exact, case_insensitive, or contains (case-insensitive)" },
      },
      required: ["table", "where"],
    },
    run: async (context) => {
      const formula = buildMatchFormula(context.args.where, context.args.match);
      const { page, next_cursor } = await listRecordsPage(context, formula);
      return { data: { ...page, filter_by_formula: formula }, next_cursor };
    },
  },
  {
    name: "get_record",
    title: "Get record",
    description: "Get one Airtable record by id.",
    parameters: {
      type: "object",
      properties: { base_id: BASE_ID_PROPERTY, table: TABLE_PROPERTY, record_id: { type: "string", description: 'Record id ("rec...")' } },
      required: ["table", "record_id"],
    },
    run: async (context) => {
      const path = `${tablePath(context)}/${pathSegment(validateRecordId(context.args.record_id))}`;
      return { data: await context.client.request({ path, signal: context.signal }) };
    },
  },
  {
    name: "create_records",
    title: "Create records",
    description: `Create up to ${MAX_RECORDS_PER_WRITE} records: [{"fields": {...}}]. Never retried after an unknown outcome.`,
    parameters: {
      type: "object",
      properties: { base_id: BASE_ID_PROPERTY, table: TABLE_PROPERTY, records: buildRecordsProperty('[{"fields": {"Name": "Acme"}}]'), typecast: TYPECAST_PROPERTY },
      required: ["table", "records"],
    },
    run: async (context) => {
      const json = { records: validateWriteRecords(context.args.records, "forbidden"), typecast: resolveTypecast(context) };
      const checkHint = "look the records up with find_records before creating them again";
      return { data: await withWriteOutcomeHint(sendRecordsWrite(context, "POST", json), checkHint) };
    },
  },
  {
    name: "update_records",
    title: "Update records",
    description: `Update fields of up to ${MAX_RECORDS_PER_WRITE} records by id (PATCH: other fields are kept): [{"id": "rec...", "fields": {...}}].`,
    parameters: {
      type: "object",
      properties: { base_id: BASE_ID_PROPERTY, table: TABLE_PROPERTY, records: buildRecordsProperty('[{"id": "rec...", "fields": {"Status": "Done"}}]'), typecast: TYPECAST_PROPERTY },
      required: ["table", "records"],
    },
    run: async (context) => {
      const json = { records: validateWriteRecords(context.args.records, "required"), typecast: resolveTypecast(context) };
      return { data: await sendRecordsWrite(context, "PATCH", json, { idempotent: true }) };
    },
  },
  {
    name: "upsert_records",
    title: "Upsert records",
    description: `Update or create up to ${MAX_RECORDS_PER_WRITE} records, matched on 1-3 fields (e.g. Email): no match creates, one match updates, several fail. Every record needs a non-empty value for each merge field.`,
    parameters: {
      type: "object",
      properties: {
        base_id: BASE_ID_PROPERTY,
        table: TABLE_PROPERTY,
        records: buildRecordsProperty('[{"fields": {"Email": "a@b.co", "Name": "Ana"}}]'),
        fields_to_merge_on: { type: "array", items: { type: "string" }, maxItems: MAX_MERGE_FIELDS, description: "1-3 fields (text, number, select or date) that identify a record" },
        typecast: TYPECAST_PROPERTY,
      },
      required: ["table", "records", "fields_to_merge_on"],
    },
    run: async (context) => {
      const records = validateWriteRecords(context.args.records, "optional");
      const fieldsToMergeOn = validateMergeFields(context.args.fields_to_merge_on, records);
      const json = { records, typecast: resolveTypecast(context), performUpsert: { fieldsToMergeOn } };
      return { data: await sendRecordsWrite(context, "PATCH", json, { idempotent: true }) };
    },
  },
  {
    name: "delete_records",
    title: "Delete records",
    description: `Delete up to ${MAX_RECORDS_PER_WRITE} records by id. Workflow node only (agents cannot delete).`,
    nodeOnly: true,
    parameters: {
      type: "object",
      properties: { base_id: BASE_ID_PROPERTY, table: TABLE_PROPERTY, record_ids: { type: "array", items: { type: "string" }, maxItems: MAX_RECORDS_PER_WRITE, description: 'Record ids ("rec...")' } },
      required: ["table", "record_ids"],
    },
    run: deleteRecordsWithRetry,
  },
];
