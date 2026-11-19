/**
 * MySQL column type names and per-column value adapters.
 *
 * The pool is configured with `dateStrings`, `supportBigNumbers` and
 * `bigNumberStrings`, so dates, BIGINT and DECIMAL arrive as exact strings.
 * The adapters only turn date-time text into ISO 8601:
 * - DATETIME "2026-11-19 10:00:00.123" → "2026-11-19T10:00:00.123" (no zone, as stored)
 * - TIMESTAMP (read with session time_zone +00:00) → "2026-11-19T03:00:00.123Z"
 * Zero dates ("0000-00-00 ...") stay as MySQL writes them.
 */

const TYPE_NAMES_BY_NUMBER = new Map([
  [0, "decimal"], [1, "tinyint"], [2, "smallint"], [3, "int"], [4, "float"], [5, "double"], [6, "null"], [7, "timestamp"],
  [8, "bigint"], [9, "mediumint"], [10, "date"], [11, "time"], [12, "datetime"], [13, "year"], [14, "date"], [15, "varchar"],
  [16, "bit"], [17, "timestamp"], [18, "datetime"], [19, "time"], [242, "vector"], [245, "json"], [246, "decimal"], [247, "enum"], [248, "set"],
  [249, "tinyblob"], [250, "mediumblob"], [251, "longblob"], [252, "blob"], [253, "varchar"], [254, "char"], [255, "geometry"],
]);
const TIMESTAMP_TYPES = new Set([7, 17]);
const DATETIME_TYPES = new Set([12, 18]);
const BLOB_TYPES = new Set([249, 250, 251, 252]);
const BINARY_CHARSET = 63;

/**
 * Describes the columns and builds one value adapter per column.
 *
 * @param columnDefinitions - mysql2 column definitions `{name, columnType, characterSet}` (object[])
 * @returns `{fields: [{name, type}], adapters: [(value) => value]}` (object)
 */
export function buildColumnAdapters(columnDefinitions) {
  const fields = columnDefinitions.map((definition) => ({ name: definition.name, type: describeColumnType(definition) }));
  const adapters = columnDefinitions.map((definition) => pickAdapter(definition.columnType));
  return { fields, adapters };
}

/**
 * Names a column type: text columns are told apart from binary ones by their character set.
 *
 * @param definition - `{columnType, characterSet}` (object)
 * @returns Type name such as "varchar", "varbinary", "text" or "blob" (string)
 */
export function describeColumnType(definition) {
  const typeName = TYPE_NAMES_BY_NUMBER.get(definition.columnType) ?? `type:${definition.columnType}`;
  const isBinary = definition.characterSet === BINARY_CHARSET;
  if (BLOB_TYPES.has(definition.columnType)) return isBinary ? typeName : typeName.replace("blob", "text");
  if (definition.columnType === 253 && isBinary) return "varbinary";
  if (definition.columnType === 254 && isBinary) return "binary";
  return typeName;
}

/**
 * Converts MySQL date-time text to ISO 8601.
 *
 * @param dateTimeText - e.g. "2026-11-19 10:00:00.5" (string)
 * @param isUtc - True for TIMESTAMP values read in UTC (boolean)
 * @returns ISO text, or the input unchanged for zero dates and non-matching text (string)
 */
export function normalizeDateTimeText(dateTimeText, isUtc) {
  if (typeof dateTimeText !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(dateTimeText) || dateTimeText.startsWith("0000-")) return dateTimeText;
  return `${dateTimeText.replace(" ", "T")}${isUtc ? "Z" : ""}`;
}

function pickAdapter(columnType) {
  if (TIMESTAMP_TYPES.has(columnType)) return (value) => normalizeDateTimeText(value, true);
  if (DATETIME_TYPES.has(columnType)) return (value) => normalizeDateTimeText(value, false);
  return (value) => value;
}
