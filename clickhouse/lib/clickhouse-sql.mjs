/**
 * SQL helpers for the clickhouse plugin: identifier quoting for the generated INSERT, and query parameters
 * (`{name:Type}` in the SQL, `param_<name>=value` in the URL; https://clickhouse.com/docs/interfaces/http). Values
 * are never spliced into SQL: ClickHouse parses each `param_` value as its declared type.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_IDENTIFIER_LENGTH = 256;
const invalid = (message) => new PluginError(message, { kind: "invalid_input" });

/**
 * Backtick-quotes a database, table or column name.
 *
 * @param name - Identifier (string)
 * @returns Quoted identifier, e.g. "`events`" (string)
 * @throws PluginError kind `invalid_input` - Empty, too long, or containing line breaks or NUL
 *
 * @example
 * quoteIdentifier("my`table"); // "`my\\`table`"
 */
export function quoteIdentifier(name) {
  if (typeof name !== "string" || name === "" || name.length > MAX_IDENTIFIER_LENGTH || /[\r\n\0]/.test(name)) {
    throw invalid(`Invalid ClickHouse name ${JSON.stringify(name)}: 1-${MAX_IDENTIFIER_LENGTH} characters without line breaks`);
  }
  return `\`${name.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``;
}

/**
 * Formats one query parameter value in ClickHouse's text format.
 *
 * @param value - Scalar, or a list of scalars for Array(T) parameters (string | number | boolean | Array)
 * @returns Text value, e.g. "42" or "['a','b']" (string)
 * @throws PluginError kind `invalid_input` - Objects or nested lists
 */
export function formatParameterValue(value) {
  if (Array.isArray(value)) return `[${value.map(formatArrayItem).join(",")}]`;
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  throw invalid("Query parameter values must be strings, numbers, booleans or lists of them");
}

function formatArrayItem(item) {
  if (typeof item === "string") return `'${item.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  if (typeof item === "number" || typeof item === "boolean") return String(item);
  throw invalid("Array query parameters may only hold strings, numbers or booleans");
}

/**
 * Turns `{name: value}` into URL entries `{param_name: text}`.
 *
 * @param parameters - Query parameters (object | undefined)
 * @returns URL query entries (object)
 * @throws PluginError kind `invalid_input` - A name that is not an identifier, or a bad value
 *
 * @example
 * buildParameterQuery({ user_id: 7 }); // { param_user_id: "7" }
 */
export function buildParameterQuery(parameters) {
  const queryEntries = {};
  for (const [name, value] of Object.entries(parameters ?? {})) {
    if (!PARAMETER_NAME.test(name)) throw invalid(`Query parameter name ${JSON.stringify(name)} must be an identifier (letters, digits, _)`);
    queryEntries[`param_${name}`] = formatParameterValue(value);
  }
  return queryEntries;
}
