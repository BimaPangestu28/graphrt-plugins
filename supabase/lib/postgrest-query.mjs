/**
 * Safe PostgREST query building for the supabase plugin.
 *
 * Filters arrive structured (`{column, operator, value, negate?, language?}`) and are encoded into one logical
 * group `and=(c1.op."v1",c2.op."v2")`. Every value is wrapped in double quotes with `\` and `"` escaped
 * (https://docs.postgrest.org/en/stable/references/api/url_grammar.html, "Reserved characters"), so a value can
 * never close the quote and add operators, conditions or `or(...)` groups. Columns must be identifiers (optionally
 * with `->`/`->>` JSON arrows), operators come from a fixed list, and `is` only takes its four keywords.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

/** PostgREST horizontal filter operators (https://docs.postgrest.org/en/stable/references/api/tables_views.html). */
export const FILTER_OPERATORS = Object.freeze([
  "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "match", "imatch", "in", "is", "isdistinct",
  "fts", "plfts", "phfts", "wfts", "cs", "cd", "ov", "sl", "sr", "nxr", "nxl", "adj",
]);
const FULL_TEXT_OPERATORS = new Set(["fts", "plfts", "phfts", "wfts"]);
const IS_KEYWORDS = new Set(["null", "true", "false", "unknown"]);
const IDENTIFIER = "[\\p{L}_][\\p{L}\\p{N}_$]*";
const COLUMN_PATTERN = new RegExp(`^${IDENTIFIER}(->>?[\\p{L}\\p{N}_]+)*$`, "u");
const LANGUAGE_PATTERN = /^[a-z_]+$/;
const ORDER_TERM_PATTERN = new RegExp(`^${IDENTIFIER}(->>?[\\p{L}\\p{N}_]+)*(\\.(asc|desc))?(\\.(nullsfirst|nullslast))?$`, "u");
const MAX_FILTERS = 20;

const invalid = (message) => new PluginError(message, { kind: "invalid_input" });

/**
 * Quotes one filter value for a PostgREST logical group.
 *
 * @param value - Scalar value (string | number | boolean)
 * @returns `"value"` with `\` and `"` backslash-escaped (string)
 *
 * @example
 * quoteFilterValue('a,"b"'); // "\"a,\\\"b\\\"\""
 */
export function quoteFilterValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Encodes structured filters as the value of PostgREST's `and` query parameter.
 *
 * @param filters - `[{column, operator, value, negate?, language?}]` (object[] | undefined)
 * @returns `(col.op."v",...)`, or undefined when there are no filters (string | undefined)
 * @throws PluginError kind `invalid_input` - Unknown operator, bad column, value or language, or too many filters
 *
 * @example
 * buildFilterExpression([{ column: "status", operator: "eq", value: "open" }]); // '(status.eq."open")'
 */
export function buildFilterExpression(filters) {
  if (filters === undefined || filters.length === 0) return undefined;
  if (filters.length > MAX_FILTERS) throw invalid(`\`filters\` may have at most ${MAX_FILTERS} conditions`);
  return `(${filters.map(encodeFilter).join(",")})`;
}

function encodeFilter(filter, index) {
  const label = `filters[${index}]`;
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) throw invalid(`\`${label}\` must be an object {column, operator, value}`);
  const { column, operator, negate } = filter;
  if (typeof column !== "string" || !COLUMN_PATTERN.test(column)) {
    throw invalid(`\`${label}.column\` must be a column name (letters, digits, _; JSON paths with -> or ->>), got ${JSON.stringify(column)}`);
  }
  if (!FILTER_OPERATORS.includes(operator)) throw invalid(`\`${label}.operator\` must be one of ${FILTER_OPERATORS.join(", ")}`);
  const prefix = negate === true ? "not." : "";
  return `${column}.${prefix}${encodeOperator(filter, label)}.${encodeOperand(filter, label)}`;
}

function encodeOperator({ operator, language }, label) {
  if (language === undefined) return operator;
  if (!FULL_TEXT_OPERATORS.has(operator)) throw invalid(`\`${label}.language\` is only for fts, plfts, phfts and wfts`);
  if (typeof language !== "string" || !LANGUAGE_PATTERN.test(language)) throw invalid(`\`${label}.language\` must be a text search configuration name such as english`);
  return `${operator}(${language})`;
}

function encodeOperand({ operator, value }, label) {
  if (operator === "is") return encodeIsKeyword(value, label);
  if (operator === "in") {
    if (!Array.isArray(value) || value.length === 0) throw invalid(`\`${label}.value\` for in must be a non-empty list of values`);
    return `(${value.map((item, itemIndex) => quoteFilterValue(checkScalar(item, `${label}.value[${itemIndex}]`))).join(",")})`;
  }
  if (value === null) throw invalid(`\`${label}.value\` is null: use operator is with null`);
  return quoteFilterValue(checkScalar(value, `${label}.value`));
}

function encodeIsKeyword(value, label) {
  const keyword = value === null ? "null" : String(value).toLowerCase();
  if (!IS_KEYWORDS.has(keyword)) throw invalid(`\`${label}.value\` for is must be null, true, false or unknown`);
  return keyword;
}

function checkScalar(value, label) {
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  throw invalid(`\`${label}\` must be a string, number or boolean value`);
}

/**
 * Checks a PostgREST `order` value: comma-separated `column[.asc|.desc][.nullsfirst|.nullslast]`.
 *
 * @param order - e.g. "created_at.desc,id" (string)
 * @returns The order with spaces around terms removed (string)
 * @throws PluginError kind `invalid_input` - Any other syntax
 */
export function validateOrder(order) {
  const terms = String(order).split(",").map((term) => term.trim());
  if (terms.some((term) => !ORDER_TERM_PATTERN.test(term))) {
    throw invalid("`order` must be comma-separated column[.asc|.desc][.nullsfirst|.nullslast] terms, e.g. created_at.desc,id");
  }
  return terms.join(",");
}
