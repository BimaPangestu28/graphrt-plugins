/**
 * Shapes SQL API results: decoded rows within row and byte caps, and cursors that name the statement handle, the
 * result partition and the row offset inside it, so a page cut short by a cap resumes exactly.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { decodeRows } from "./snowflake-values.mjs";

export const STATEMENT_HANDLE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Encodes a results cursor.
 *
 * @param position - `{handle, partition, offset}` (object)
 * @returns base64url cursor (string)
 */
export function encodeResultsCursor({ handle, partition, offset }) {
  return Buffer.from(JSON.stringify({ h: handle, p: partition, o: offset }), "utf8").toString("base64url");
}

/**
 * Decodes and checks a results cursor.
 *
 * @param cursor - From encodeResultsCursor (string)
 * @returns `{handle, partition, offset}` (object)
 * @throws PluginError kind `invalid_input` - When the cursor was not produced by this plugin
 */
export function decodeResultsCursor(cursor) {
  let position;
  try {
    position = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    position = undefined;
  }
  if (!position || !STATEMENT_HANDLE_PATTERN.test(position.h ?? "") || !Number.isSafeInteger(position.p) || position.p < 0 || !Number.isSafeInteger(position.o) || position.o < 0) {
    throw new PluginError("`cursor` is not a next_cursor from execute or get_statement_results", { kind: "invalid_input" });
  }
  return { handle: position.h, partition: position.p, offset: position.o };
}

function capRows(rows, { maxRows, maxResultBytes }) {
  let totalBytes = 2;
  const keptRows = [];
  for (const row of rows.slice(0, maxRows)) {
    totalBytes += Buffer.byteLength(JSON.stringify(row)) + 1;
    if (totalBytes > maxResultBytes && keptRows.length > 0) break;
    keptRows.push(row);
  }
  return keptRows;
}

function findNextPosition({ handle, partition, offset }, keptCount, partitionRowCount, partitionCount) {
  if (offset + keptCount < partitionRowCount) return { handle, partition, offset: offset + keptCount };
  if (partition + 1 < partitionCount) return { handle, partition: partition + 1, offset: 0 };
  return null;
}

/**
 * Builds the operation output for one partition's rows.
 *
 * @param metadata - The statement's resultSetMetaData (from the first response) (object)
 * @param partitionRows - `data` of the partition (Array<Array<string | null>>)
 * @param position - `{handle, partition, offset}` of the first row to return (object)
 * @param limits - `{maxRows, maxResultBytes}` (object)
 * @returns `{rows, truncated, next_cursor}` (object)
 */
export function shapePartitionPage(metadata, partitionRows, position, limits) {
  const decodedRows = decodeRows(metadata?.rowType, (partitionRows ?? []).slice(position.offset));
  const rows = capRows(decodedRows, limits);
  const partitionCount = metadata?.partitionInfo?.length ?? 1;
  const nextPosition = findNextPosition(position, rows.length, (partitionRows ?? []).length, partitionCount);
  return { rows, truncated: nextPosition !== null, next_cursor: nextPosition ? encodeResultsCursor(nextPosition) : null };
}

/**
 * Summarizes a finished statement's first response (ResultSet).
 *
 * @param resultSet - SQL API ResultSet (object)
 * @param limits - `{maxRows, maxResultBytes}` (object)
 * @returns `{data, next_cursor}` (object)
 */
export function shapeResultSet(resultSet, limits) {
  const metadata = resultSet.resultSetMetaData ?? {};
  const page = shapePartitionPage(metadata, resultSet.data, { handle: resultSet.statementHandle, partition: 0, offset: 0 }, limits);
  return {
    data: {
      status: "succeeded",
      statement_handle: resultSet.statementHandle ?? null,
      columns: (metadata.rowType ?? []).map((column) => ({ name: column.name, type: column.type, nullable: column.nullable ?? null, scale: column.scale ?? null })),
      rows: page.rows,
      total_rows: metadata.numRows ?? null,
      truncated: page.truncated,
      stats: resultSet.stats ?? null,
      message: resultSet.message ?? null,
    },
    next_cursor: resultSet.statementHandle ? page.next_cursor : null,
  };
}
