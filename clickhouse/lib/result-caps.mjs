/**
 * Client-side result caps for `query` when the server cannot apply them: a user whose profile is readonly=1 refuses
 * every URL setting, so the query is resent without max_result_rows / max_result_bytes. The caps are then applied
 * here to the parsed JSON result, with the same meaning as ClickHouse's result_overflow_mode: "throw" fails, "break"
 * keeps the first rows that fit. The server-side work and the response size are bounded only by the profile's own
 * limits and the request timeout in that case (see README "Users whose profile is already read-only").
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

/**
 * Applies the row and byte caps to a ClickHouse JSON result (`{meta, data, rows, ...}`).
 *
 * @param result - Parsed JSON-format result (object)
 * @param caps - Caps (object)
 * @param caps.maxRows - Row cap (number)
 * @param caps.maxBytes - Cap on the UTF-8 size of the serialized `data` rows (number)
 * @param caps.overflowMode - "throw" or "break" (string)
 * @returns The result unchanged when it fits; with "break", a copy with the first rows that fit, `rows` updated
 *   and `result_truncated: true` (object)
 * @throws PluginError kind `invalid_input` - "throw" mode and a cap is exceeded
 *
 * @example
 * enforceResultCaps({ data: [{ n: 1 }, { n: 2 }], rows: 2 }, { maxRows: 1, maxBytes: 1e6, overflowMode: "break" });
 * // { data: [{ n: 1 }], rows: 1, result_truncated: true }
 */
export function enforceResultCaps(result, { maxRows, maxBytes, overflowMode }) {
  if (!Array.isArray(result?.data)) return result;
  const keptRowCount = countRowsWithinCaps(result.data, maxRows, maxBytes);
  if (keptRowCount === result.data.length) return result;
  if (overflowMode !== "break") {
    const exceeded = result.data.length > maxRows && keptRowCount === maxRows ? `max_result_rows (${maxRows})` : `max_result_bytes (${maxBytes})`;
    throw new PluginError(
      `Query result exceeds ${exceeded}, enforced client-side because this user's readonly=1 profile refuses the server-side caps; add a LIMIT, or use result_overflow_mode "break"`,
      { kind: "invalid_input" },
    );
  }
  const data = result.data.slice(0, keptRowCount);
  return { ...result, data, rows: data.length, result_truncated: true };
}

// Rows are counted as JSON array elements: "[" + rows joined by "," + "]".
function countRowsWithinCaps(rows, maxRows, maxBytes) {
  let serializedBytes = 2;
  const rowLimit = Math.min(rows.length, maxRows);
  for (let rowIndex = 0; rowIndex < rowLimit; rowIndex += 1) {
    serializedBytes += Buffer.byteLength(JSON.stringify(rows[rowIndex]) ?? "null") + (rowIndex > 0 ? 1 : 0);
    if (serializedBytes > maxBytes) return rowIndex;
  }
  return rowLimit;
}
