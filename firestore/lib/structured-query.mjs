/**
 * Builds a Firestore StructuredQuery from simple arguments: one collection (or collection group), `where`
 * filters combined with AND, `order_by`, `select`, `limit` and `offset`. Filter values are typed Firestore values,
 * never text spliced into a query.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { assertFirestoreValue, encodeValue } from "./firestore-values.mjs";

const OPERATOR_ALIASES = {
  "==": "EQUAL",
  "!=": "NOT_EQUAL",
  "<": "LESS_THAN",
  "<=": "LESS_THAN_OR_EQUAL",
  ">": "GREATER_THAN",
  ">=": "GREATER_THAN_OR_EQUAL",
  "array-contains": "ARRAY_CONTAINS",
  in: "IN",
  "array-contains-any": "ARRAY_CONTAINS_ANY",
  "not-in": "NOT_IN",
};
const FIELD_OPERATORS = new Set(["EQUAL", "NOT_EQUAL", "LESS_THAN", "LESS_THAN_OR_EQUAL", "GREATER_THAN", "GREATER_THAN_OR_EQUAL", "ARRAY_CONTAINS", "IN", "ARRAY_CONTAINS_ANY", "NOT_IN"]);
const UNARY_OPERATORS = new Set(["IS_NULL", "IS_NAN", "IS_NOT_NULL", "IS_NOT_NAN"]);
const COLLECTION_ID_PATTERN = /^[^/]{1,1500}$/;

function encodeFilterValue(value, valueFormat, label) {
  if (valueFormat !== "typed") return encodeValue(value, label);
  assertFirestoreValue(value, label);
  return value;
}

function buildFilter(filter, index, valueFormat) {
  const label = `where[${index}]`;
  if (!filter || typeof filter.field !== "string" || filter.field === "" || typeof filter.op !== "string") {
    throw new PluginError(`\`${label}\` must be {"field": "...", "op": "==", "value": ...}`, { kind: "invalid_input" });
  }
  const operator = OPERATOR_ALIASES[filter.op] ?? filter.op.toUpperCase();
  if (UNARY_OPERATORS.has(operator)) return { unaryFilter: { op: operator, field: { fieldPath: filter.field } } };
  if (!FIELD_OPERATORS.has(operator)) throw new PluginError(`\`${label}.op\` ${JSON.stringify(filter.op)} is not a Firestore operator (==, !=, <, <=, >, >=, array-contains, in, array-contains-any, not-in, IS_NULL, ...)`, { kind: "invalid_input" });
  if (!("value" in filter)) throw new PluginError(`\`${label}\` needs a value`, { kind: "invalid_input" });
  return { fieldFilter: { field: { fieldPath: filter.field }, op: operator, value: encodeFilterValue(filter.value, valueFormat, `${label}.value`) } };
}

function buildOrderBy(orderBy) {
  return orderBy.map((order, index) => {
    const [fieldPath, direction = "asc"] = typeof order === "string" ? order.trim().split(/\s+/) : [order?.field, order?.direction];
    if (typeof fieldPath !== "string" || !/^(asc|desc)$/i.test(direction)) throw new PluginError(`\`order_by[${index}]\` must be "field" or "field desc"`, { kind: "invalid_input" });
    return { field: { fieldPath }, direction: /^desc$/i.test(direction) ? "DESCENDING" : "ASCENDING" };
  });
}

/**
 * Builds the StructuredQuery.
 *
 * @param args - `{collection_id, all_descendants, where, order_by, select, limit, offset, value_format}` (object)
 * @returns StructuredQuery (object)
 * @throws PluginError kind `invalid_input` - Bad collection id, filters or ordering
 *
 * @example
 * buildStructuredQuery({ collection_id: "orders", where: [{ field: "status", op: "==", value: "open" }], limit: 10 });
 */
export function buildStructuredQuery(args) {
  if (!COLLECTION_ID_PATTERN.test(args.collection_id)) throw new PluginError("`collection_id` is a single collection id without slashes", { kind: "invalid_input" });
  const filters = (args.where ?? []).map((filter, index) => buildFilter(filter, index, args.value_format));
  const structuredQuery = { from: [{ collectionId: args.collection_id, allDescendants: args.all_descendants === true }], limit: args.limit };
  if (filters.length === 1) structuredQuery.where = filters[0];
  if (filters.length > 1) structuredQuery.where = { compositeFilter: { op: "AND", filters } };
  if (args.order_by) structuredQuery.orderBy = buildOrderBy(args.order_by);
  if (args.select) structuredQuery.select = { fields: args.select.map((fieldPath) => ({ fieldPath })) };
  if (args.offset) structuredQuery.offset = args.offset;
  return structuredQuery;
}
