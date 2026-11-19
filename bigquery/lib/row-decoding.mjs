/**
 * Decodes BigQuery result rows (`{f: [{v}]}` cells) into plain objects using the result schema.
 *
 * INT64 becomes a number when exact and a string otherwise; NUMERIC/BIGNUMERIC stay strings (exact decimals);
 * FLOAT64 is a number except NaN/Infinity (strings); TIMESTAMP is requested as int64 microseconds and returned as
 * ISO 8601 with microseconds; JSON is parsed; RECORD and REPEATED nest; DATE, TIME, DATETIME, GEOGRAPHY and
 * BYTES (base64) stay the strings BigQuery sends.
 */

const INTEGER_TYPES = new Set(["INTEGER", "INT64"]);
const FLOAT_TYPES = new Set(["FLOAT", "FLOAT64"]);
const BOOLEAN_TYPES = new Set(["BOOLEAN", "BOOL"]);
const RECORD_TYPES = new Set(["RECORD", "STRUCT"]);

/**
 * Decodes rows.
 *
 * @param schema - Result schema `{fields}` (object)
 * @param rows - Rows from jobs.query or getQueryResults (object[] | undefined)
 * @returns Row objects keyed by column name (object[])
 */
export function decodeRows(schema, rows) {
  const fields = schema?.fields ?? [];
  return (rows ?? []).map((row) => decodeRecord(fields, row));
}

function decodeRecord(fields, record) {
  return Object.fromEntries(fields.map((field, index) => [field.name, decodeField(field, record?.f?.[index]?.v)]));
}

function decodeField(field, cellValue) {
  if (cellValue === null || cellValue === undefined) return field.mode === "REPEATED" ? [] : null;
  if (field.mode === "REPEATED") return cellValue.map((element) => decodeScalarOrRecord(field, element?.v));
  return decodeScalarOrRecord(field, cellValue);
}

function decodeScalarOrRecord(field, cellValue) {
  if (cellValue === null || cellValue === undefined) return null;
  const type = String(field.type).toUpperCase();
  if (RECORD_TYPES.has(type)) return decodeRecord(field.fields ?? [], cellValue);
  if (INTEGER_TYPES.has(type)) return toExactNumber(cellValue);
  if (FLOAT_TYPES.has(type)) return Number.isFinite(Number(cellValue)) ? Number(cellValue) : cellValue;
  if (BOOLEAN_TYPES.has(type)) return cellValue === "true";
  if (type === "TIMESTAMP") return formatMicroseconds(cellValue);
  if (type === "JSON") return parseJsonCell(cellValue);
  return cellValue;
}

function toExactNumber(integerText) {
  const parsed = Number(integerText);
  return Number.isSafeInteger(parsed) ? parsed : integerText;
}

// "1763546400123456" (µs since the epoch) -> "2025-11-19T10:00:00.123456Z"; anything else is returned unchanged.
function formatMicroseconds(timestampText) {
  if (!/^-?\d+$/.test(timestampText)) return timestampText;
  const microseconds = BigInt(timestampText);
  const milliseconds = microseconds / 1000n - (microseconds % 1000n < 0n ? 1n : 0n);
  const extraMicroseconds = ((microseconds % 1000n) + 1000n) % 1000n;
  const isoText = new Date(Number(milliseconds)).toISOString();
  return `${isoText.slice(0, -1)}${String(extraMicroseconds).padStart(3, "0")}Z`;
}

function parseJsonCell(jsonText) {
  try {
    return JSON.parse(jsonText);
  } catch {
    return jsonText;
  }
}

/**
 * Flattens a table or result schema to one row per (nested) field.
 *
 * @param schema - `{fields}` (object)
 * @returns `[{name, type, mode, description}]` with dotted names for nested fields (object[])
 */
export function summarizeSchema(schema) {
  const flattened = [];
  const visit = (fields, prefix) => {
    for (const field of fields ?? []) {
      const name = `${prefix}${field.name}`;
      flattened.push({ name, type: field.type, mode: field.mode ?? "NULLABLE", description: field.description ?? null });
      if (field.fields) visit(field.fields, `${name}.`);
    }
  };
  visit(schema?.fields, "");
  return flattened;
}
