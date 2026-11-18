/**
 * `delete_records` (workflow node only) with its own retry.
 *
 * A DELETE whose first attempt failed with a 5xx or a network error may already have deleted the records. When
 * the retry then answers 404/422 for those ids, they are gone, so the call counts as done (`already_absent:
 * true`). A not-found on the first attempt (or after a 429, which means nothing happened) stays an error.
 */
import { setTimeout as delay } from "node:timers/promises";
import { rejectInput, tablePath, validateRecordId } from "../lib/client.mjs";

const DEFAULT_RETRY_DELAY_MS = 1000;
const MAX_ATTEMPTS = 2;
const ABSENT_RECORD_STATUS_PATTERN = /^API error (404|422):/;

/**
 * Deletes up to 10 records by id, retrying once after a retryable failure.
 *
 * @param context - `{client, args, environment, source, signal}` with args.table and args.record_ids (object)
 * @returns `{data}`: Airtable's `{records: [{id, deleted}]}`, plus `already_absent: true` when a retry found them gone (Promise<object>)
 * @throws PluginError - `invalid_input` for bad ids, or the API error when the delete did not happen
 */
export async function deleteRecordsWithRetry(context) {
  const { args } = context;
  if (args.record_ids.length === 0) rejectInput("`record_ids` must have at least one id");
  // `records[]` repeats, which the client's query object cannot express; the ids are validated, so they are safe in the path.
  const recordsQuery = args.record_ids.map((recordId) => `records[]=${validateRecordId(recordId)}`).join("&");
  const path = `${tablePath(context)}?${recordsQuery}`;
  let mayHaveDeleted = false;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { data: await context.client.requestOnce({ method: "DELETE", path, signal: context.signal }) };
    } catch (deleteError) {
      if (mayHaveDeleted && isAbsentRecordsError(deleteError)) return { data: buildAlreadyAbsentResult(args.record_ids) };
      if (attempt >= MAX_ATTEMPTS || !deleteError.retryable) throw deleteError;
      mayHaveDeleted ||= deleteError.kind !== "rate_limited";
      await delay(deleteError.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS, undefined, { signal: context.signal });
    }
  }
}

function isAbsentRecordsError(pluginError) {
  return ABSENT_RECORD_STATUS_PATTERN.test(pluginError?.message ?? "");
}

function buildAlreadyAbsentResult(recordIds) {
  return { records: recordIds.map((recordId) => ({ id: recordId, deleted: true })), already_absent: true };
}
