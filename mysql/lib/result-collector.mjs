/**
 * Collects result rows under a row cap and a byte cap.
 *
 * Drivers feed array rows one at a time; the collector converts each row to a
 * JSON-safe object and says when to stop reading. Reading stops at the first
 * row past `maxRows` (so `truncated` is only true when more rows existed) or
 * at the first row that would push the JSON size past `maxBytes`.
 * This file is identical in the postgres, mysql and sqlite plugins; keep the copies in step.
 */
import { convertArrayRow, DEFAULT_MAX_BINARY_BYTES, deduplicateColumnNames } from "./value-conversion.mjs";

/**
 * Creates a row collector.
 *
 * @param options - Collector options (object)
 * @param options.columnNames - Raw column names in order (string[])
 * @param options.maxRows - Most rows to keep (number)
 * @param options.maxBytes - Most JSON bytes of all kept rows together (number)
 * @param options.maxBinaryBytes - Most raw bytes per binary value (number, default 65536)
 * @returns `{addRow(arrayRow) => boolean, finish() => result, isFull() => boolean, markTruncated(reason), bytesCollected() => number}`;
 *   addRow returns false when reading should stop (object)
 *
 * @example
 * const collector = createResultCollector({ columnNames: ["id"], maxRows: 2, maxBytes: 1000 });
 * collector.addRow([1]); collector.addRow([2]); collector.addRow([3]); // third call returns false
 * collector.finish(); // { rows: [{id: 1}, {id: 2}], row_count: 2, truncated: true, truncated_reason: "max_rows" }
 */
export function createResultCollector({ columnNames, maxRows, maxBytes, maxBinaryBytes = DEFAULT_MAX_BINARY_BYTES }) {
  const outputNames = deduplicateColumnNames(columnNames);
  const conversionState = { maxBinaryBytes, valuesTruncated: false };
  const rows = [];
  let totalBytes = 2;
  let truncatedReason = null;
  return {
    addRow(arrayRow) {
      if (truncatedReason) return false;
      if (rows.length >= maxRows) {
        truncatedReason = "max_rows";
        return false;
      }
      const rowObject = convertArrayRow(arrayRow, outputNames, conversionState);
      const rowBytes = Buffer.byteLength(JSON.stringify(rowObject)) + 1;
      if (totalBytes + rowBytes > maxBytes) {
        truncatedReason = "max_bytes";
        return false;
      }
      rows.push(rowObject);
      totalBytes += rowBytes;
      return true;
    },
    isFull: () => truncatedReason !== null,
    // Used when the driver stopped reading on its own (e.g. too many bytes arrived on the socket).
    markTruncated(reason) {
      truncatedReason ??= reason;
    },
    bytesCollected: () => totalBytes,
    finish: () => buildResult(rows, truncatedReason, conversionState.valuesTruncated),
  };
}

function buildResult(rows, truncatedReason, valuesTruncated) {
  const result = { rows, row_count: rows.length, truncated: truncatedReason !== null };
  if (truncatedReason) result.truncated_reason = truncatedReason;
  if (valuesTruncated) result.values_truncated = true;
  return result;
}
