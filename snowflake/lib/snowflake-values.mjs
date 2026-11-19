/**
 * Snowflake SQL API values: positional bindings for `?` placeholders, and decoding of jsonv2 result cells (every
 * cell arrives as a string or null) by the column's rowType.
 *
 * Decoded: FIXED with scale 0 -> number when exact, else string; FIXED with a scale -> exact decimal string;
 * REAL -> number; BOOLEAN -> boolean; DATE -> YYYY-MM-DD; TIME -> HH:MM:SS.fffffffff; TIMESTAMP_NTZ -> ISO without
 * offset; TIMESTAMP_LTZ -> ISO in UTC ("Z"); TIMESTAMP_TZ -> ISO in its own offset; VARIANT/OBJECT/ARRAY -> parsed
 * JSON; TEXT, BINARY (hex) and others -> the string.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const BINDING_TYPE_PATTERN = /^(TEXT|FIXED|REAL|BOOLEAN|DATE|TIME|TIMESTAMP_NTZ|TIMESTAMP_LTZ|TIMESTAMP_TZ|BINARY)$/;
const SECONDS_PER_DAY = 86400;

/**
 * Builds the `bindings` object for `?` placeholders.
 *
 * @param bindValues - Positional values: string, number, boolean, null or `{type, value}` (array | undefined)
 * @returns `{"1": {type, value}, ...}` or undefined without values (object | undefined)
 * @throws PluginError kind `invalid_input` - Unknown types, objects without a type, inexact integers
 *
 * @example
 * buildBindings(["open", 10]); // { 1: { type: "TEXT", value: "open" }, 2: { type: "FIXED", value: "10" } }
 */
export function buildBindings(bindValues) {
  if (bindValues === undefined) return undefined;
  return Object.fromEntries(bindValues.map((value, index) => [String(index + 1), buildBinding(value, `bindings[${index}]`)]));
}

function buildBinding(value, label) {
  if (value === null) return { type: "TEXT", value: null };
  if (typeof value === "string") return { type: "TEXT", value };
  if (typeof value === "boolean") return { type: "BOOLEAN", value: String(value) };
  if (typeof value === "number") return buildNumberBinding(value, label);
  if (typeof value === "object" && !Array.isArray(value) && typeof value.type === "string" && BINDING_TYPE_PATTERN.test(value.type)) {
    return { type: value.type, value: value.value === null || value.value === undefined ? null : String(value.value) };
  }
  throw new PluginError(`${label} needs a type: pass {"type": "DATE" | "TIMESTAMP_NTZ" | "FIXED" | ..., "value": "..."}`, { kind: "invalid_input" });
}

function buildNumberBinding(value, label) {
  if (!Number.isFinite(value)) throw new PluginError(`${label} must be a finite number`, { kind: "invalid_input" });
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new PluginError(`${label} is too large to be exact; pass {"type": "FIXED", "value": "<digits>"}`, { kind: "invalid_input" });
  return { type: Number.isInteger(value) ? "FIXED" : "REAL", value: String(value) };
}

/**
 * Decodes result rows (arrays of strings) into objects keyed by column name.
 *
 * @param rowType - resultSetMetaData.rowType (object[])
 * @param rows - `data` rows (Array<Array<string | null>> | undefined)
 * @returns Row objects (object[])
 */
export function decodeRows(rowType, rows) {
  const columnNames = uniqueColumnNames(rowType ?? []);
  return (rows ?? []).map((row) => Object.fromEntries(columnNames.map((columnName, index) => [columnName, decodeCell(rowType[index], row[index])])));
}

// Two columns with the same name (a join) become NAME and NAME_2 instead of overwriting each other.
function uniqueColumnNames(rowType) {
  const seenCounts = new Map();
  return rowType.map((column) => {
    const count = (seenCounts.get(column.name) ?? 0) + 1;
    seenCounts.set(column.name, count);
    return count === 1 ? column.name : `${column.name}_${count}`;
  });
}

function decodeCell(column, cell) {
  if (cell === null || cell === undefined) return null;
  const type = String(column?.type ?? "text").toLowerCase();
  const decoders = {
    fixed: () => (column.scale ? cell : toExactNumber(cell)),
    real: () => (Number.isFinite(Number(cell)) ? Number(cell) : cell),
    boolean: () => cell === "true" || cell === "1",
    date: () => new Date(Number(cell) * SECONDS_PER_DAY * 1000).toISOString().slice(0, 10),
    time: () => formatTimeOfDay(cell),
    timestamp_ntz: () => formatEpoch(cell, 0, ""),
    timestamp_ltz: () => formatEpoch(cell, 0, "Z"),
    timestamp_tz: () => formatZonedEpoch(cell),
    variant: () => parseJson(cell),
    object: () => parseJson(cell),
    array: () => parseJson(cell),
  };
  return (decoders[type] ?? (() => cell))();
}

function toExactNumber(numberText) {
  const parsed = Number(numberText);
  return Number.isSafeInteger(parsed) ? parsed : numberText;
}

function splitSeconds(secondsText) {
  const [wholeSeconds, fraction = ""] = String(secondsText).split(".");
  return { wholeSeconds: Number(wholeSeconds), fraction };
}

function formatTimeOfDay(secondsText) {
  const { wholeSeconds, fraction } = splitSeconds(secondsText);
  const clock = new Date(wholeSeconds * 1000).toISOString().slice(11, 19);
  return fraction ? `${clock}.${fraction}` : clock;
}

// "<epoch seconds>.<fraction>" shifted by offsetMinutes, keeping every fractional digit.
function formatEpoch(secondsText, offsetMinutes, suffix) {
  const { wholeSeconds, fraction } = splitSeconds(secondsText);
  if (!Number.isFinite(wholeSeconds)) return secondsText;
  const wallClock = new Date((wholeSeconds + offsetMinutes * 60) * 1000).toISOString().slice(0, 19);
  return `${wallClock}${fraction ? `.${fraction}` : ""}${suffix}`;
}

// TIMESTAMP_TZ: "<epoch>.<fraction> <offset minutes + 1440>".
function formatZonedEpoch(cell) {
  const [secondsText, encodedOffset] = String(cell).split(" ");
  const offsetMinutes = Number(encodedOffset) - 1440;
  if (!Number.isFinite(offsetMinutes)) return formatEpoch(secondsText, 0, "Z");
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const offsetText = `${sign}${String(Math.floor(absoluteMinutes / 60)).padStart(2, "0")}:${String(absoluteMinutes % 60).padStart(2, "0")}`;
  return formatEpoch(secondsText, offsetMinutes, offsetText);
}

function parseJson(jsonText) {
  try {
    return JSON.parse(jsonText);
  } catch {
    return jsonText;
  }
}
