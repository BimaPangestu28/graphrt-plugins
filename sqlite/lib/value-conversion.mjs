/**
 * Turns driver values into JSON-safe output values.
 *
 * - 64-bit integers (BigInt) become numbers only when they are exact, otherwise strings.
 * - Binary values (Buffer / Uint8Array) become base64, cut to `maxBinaryBytes` raw bytes.
 * - Dates become ISO 8601 strings (invalid dates become null).
 * - NaN and ±Infinity become strings ("NaN", "Infinity", "-Infinity").
 * - Arrays and plain objects (JSON columns) are converted recursively.
 *
 * Drivers are configured so that decimals and 64-bit integer columns already arrive as strings.
 * This file is identical in the postgres, mysql and sqlite plugins; keep the copies in step.
 */

export const DEFAULT_MAX_BINARY_BYTES = 65536;

/**
 * Converts one value; records cut binary values in `conversionState.valuesTruncated`.
 *
 * @param value - Value from the driver (unknown)
 * @param conversionState - `{maxBinaryBytes, valuesTruncated}`; `valuesTruncated` is set to true when a value was cut (object)
 * @returns JSON-safe value (unknown)
 *
 * @example
 * const state = { maxBinaryBytes: 4, valuesTruncated: false };
 * convertValue(Buffer.from("hello"), state); // "aGVsbA==" and state.valuesTruncated === true
 */
export function convertValue(value, conversionState) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (value instanceof Uint8Array) return convertBinary(value, conversionState);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map((item) => convertValue(item, conversionState));
  if (typeof value === "object") return convertObject(value, conversionState);
  return value;
}

/**
 * Builds a row object from an array row, using already de-duplicated column names.
 *
 * @param arrayRow - Values in column order (unknown[])
 * @param columnNames - Output keys, one per column (string[])
 * @param conversionState - See convertValue (object)
 * @returns Row object (object)
 */
export function convertArrayRow(arrayRow, columnNames, conversionState) {
  const rowObject = {};
  columnNames.forEach((columnName, columnIndex) => {
    rowObject[columnName] = convertValue(arrayRow[columnIndex], conversionState);
  });
  return rowObject;
}

/**
 * Makes column names unique so no value is lost in a row object: `id`, `id` → `id`, `id_2`.
 *
 * @param rawNames - Column names from the driver (string[])
 * @returns Unique names in the same order (string[])
 */
export function deduplicateColumnNames(rawNames) {
  const usedNames = new Set();
  return rawNames.map((rawName) => {
    const baseName = rawName === "" || rawName === undefined || rawName === null ? "column" : String(rawName);
    let candidateName = baseName;
    for (let suffix = 2; usedNames.has(candidateName); suffix += 1) candidateName = `${baseName}_${suffix}`;
    usedNames.add(candidateName);
    return candidateName;
  });
}

function convertBinary(binaryValue, conversionState) {
  const maxBinaryBytes = conversionState.maxBinaryBytes ?? DEFAULT_MAX_BINARY_BYTES;
  const bytes = Buffer.from(binaryValue.buffer, binaryValue.byteOffset, binaryValue.byteLength);
  if (bytes.length <= maxBinaryBytes) return bytes.toString("base64");
  conversionState.valuesTruncated = true;
  return bytes.subarray(0, maxBinaryBytes).toString("base64");
}

// Driver objects such as a postgres interval expose toISOString(); JSON values are plain objects.
function convertObject(objectValue, conversionState) {
  if (typeof objectValue.toISOString === "function") return objectValue.toISOString();
  const convertedObject = {};
  for (const [key, nestedValue] of Object.entries(objectValue)) convertedObject[key] = convertValue(nestedValue, conversionState);
  return convertedObject;
}
