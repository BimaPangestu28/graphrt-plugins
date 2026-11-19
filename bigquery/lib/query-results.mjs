/**
 * Shapes jobs.query / jobs.getQueryResults responses: decoded rows within a byte cap, and a cursor that names
 * the job and the next row index (getQueryResults' startIndex), so a page cut short by the cap resumes exactly.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { checkLocation, checkProjectId } from "./settings.mjs";
import { decodeRows, summarizeSchema } from "./row-decoding.mjs";

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/;

/**
 * Encodes a results cursor.
 *
 * @param position - `{projectId, jobId, location, startIndex}` (object)
 * @returns base64url cursor (string)
 */
export function encodeResultsCursor({ projectId, jobId, location, startIndex }) {
  return Buffer.from(JSON.stringify({ p: projectId, j: jobId, l: location ?? null, s: startIndex }), "utf8").toString("base64url");
}

/**
 * Decodes and checks a results cursor.
 *
 * @param cursor - From encodeResultsCursor (string)
 * @returns `{projectId, jobId, location, startIndex}` (object)
 * @throws PluginError kind `invalid_input` - When the cursor was not produced by this plugin
 */
export function decodeResultsCursor(cursor) {
  let position;
  try {
    position = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    position = undefined;
  }
  const isValid = position && JOB_ID_PATTERN.test(position.j ?? "") && Number.isSafeInteger(position.s) && position.s >= 0 && typeof position.p === "string";
  if (!isValid) throw new PluginError("`cursor` is not a next_cursor from query or get_query_results", { kind: "invalid_input" });
  checkProjectId(position.p, "cursor project");
  if (position.l !== null) checkLocation(position.l, "cursor location");
  return { projectId: position.p, jobId: position.j, location: position.l ?? undefined, startIndex: position.s };
}

// Keeps whole rows while their JSON stays within maxResultBytes.
function capRows(rows, maxResultBytes) {
  let totalBytes = 2;
  const keptRows = [];
  for (const row of rows) {
    totalBytes += Buffer.byteLength(JSON.stringify(row)) + 1;
    if (totalBytes > maxResultBytes && keptRows.length > 0) break;
    keptRows.push(row);
  }
  return keptRows;
}

/**
 * Builds the operation output from a query results response.
 *
 * @param response - jobs.query or getQueryResults response (object)
 * @param options - `{startIndex, maxResultBytes}` (object)
 * @returns `{data, next_cursor}` (object)
 */
export function shapeQueryResults(response, { startIndex, maxResultBytes }) {
  const jobReference = response.jobReference ?? {};
  const position = { projectId: jobReference.projectId, jobId: jobReference.jobId, location: jobReference.location };
  if (response.jobComplete === false) {
    return { data: { job_id: position.jobId ?? null, location: position.location ?? null, job_complete: false, rows: [], note: "The query is still running: call get_query_results with next_cursor" }, next_cursor: position.jobId ? encodeResultsCursor({ ...position, startIndex: 0 }) : null };
  }
  const decodedRows = decodeRows(response.schema, response.rows);
  const rows = capRows(decodedRows, maxResultBytes);
  const totalRows = response.totalRows === undefined ? null : Number(response.totalRows);
  const nextIndex = startIndex + rows.length;
  const hasMore = totalRows !== null && nextIndex < totalRows;
  return {
    data: {
      job_id: position.jobId ?? null,
      location: position.location ?? null,
      job_complete: true,
      schema: summarizeSchema(response.schema),
      rows,
      total_rows: totalRows,
      truncated: rows.length < decodedRows.length,
      total_bytes_processed: response.totalBytesProcessed === undefined ? null : Number(response.totalBytesProcessed),
      total_bytes_billed: response.totalBytesBilled === undefined ? null : Number(response.totalBytesBilled),
      cache_hit: response.cacheHit ?? null,
      affected_rows: response.numDmlAffectedRows === undefined ? null : Number(response.numDmlAffectedRows),
    },
    next_cursor: hasMore && position.jobId ? encodeResultsCursor({ ...position, startIndex: nextIndex }) : null,
  };
}
