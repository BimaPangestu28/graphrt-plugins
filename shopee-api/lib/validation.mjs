/**
 * Argument checks that the JSON-schema subset in shared/params cannot express.
 */
import { rejectInput } from "./client.mjs";

export const MAX_ORDER_WINDOW_SECONDS = 15 * 24 * 60 * 60;
// Unix seconds stay below 1e11 until the year 5138; a larger value is almost certainly milliseconds.
const MAX_UNIX_SECONDS = 1e11;

/**
 * Checks that a value is a Unix timestamp in seconds (not milliseconds).
 *
 * @param argumentName - Argument name for the error message (string)
 * @param timestamp - Value to check (number)
 * @returns The timestamp (number)
 * @throws PluginError kind `invalid_input` - When it is not a positive whole number of seconds
 */
export function requireUnixSeconds(argumentName, timestamp) {
  if (!Number.isInteger(timestamp) || timestamp <= 0 || timestamp >= MAX_UNIX_SECONDS) {
    rejectInput(`\`${argumentName}\` must be a Unix timestamp in seconds (10 digits), got ${JSON.stringify(timestamp)}`);
  }
  return timestamp;
}

/**
 * Validates a Shopee order-list window: time_from < time_to and at most 15 days apart.
 *
 * @param timeFrom - Window start, Unix seconds (number)
 * @param timeTo - Window end, Unix seconds (number)
 * @throws PluginError kind `invalid_input` - When the window is empty, reversed or longer than 15 days
 *
 * @example
 * validateOrderTimeWindow(1700000000, 1700000000 + 86400); // ok
 */
export function validateOrderTimeWindow(timeFrom, timeTo) {
  requireUnixSeconds("time_from", timeFrom);
  requireUnixSeconds("time_to", timeTo);
  if (timeTo <= timeFrom) rejectInput("`time_to` must be after `time_from`");
  if (timeTo - timeFrom > MAX_ORDER_WINDOW_SECONDS) {
    rejectInput("Shopee allows at most 15 days between `time_from` and `time_to`; split the range into several calls");
  }
}

/**
 * Checks a list of ids and joins it with commas, as Shopee list parameters expect.
 *
 * @param argumentName - Argument name for errors (string)
 * @param ids - Ids (Array<string | number>)
 * @param maxCount - Largest allowed count (number)
 * @returns Comma-separated ids (string)
 * @throws PluginError kind `invalid_input` - When the list is empty, too long or has empty/comma-containing ids
 */
export function joinIdList(argumentName, ids, maxCount) {
  if (ids.length === 0 || ids.length > maxCount) rejectInput(`\`${argumentName}\` needs 1-${maxCount} ids`);
  const idStrings = ids.map((id) => String(id).trim());
  if (idStrings.some((id) => id === "" || id.includes(","))) rejectInput(`\`${argumentName}\` has an empty or invalid id`);
  return idStrings.join(",");
}

/**
 * Checks that a value is a non-negative safe integer id (Shopee item, model and user ids are int64 in JSON).
 * Digit strings are accepted, because nested values from templates arrive as strings.
 *
 * @param argumentName - Argument name for errors (string)
 * @param id - Value to check (number | string)
 * @returns The id (number)
 * @throws PluginError kind `invalid_input` - When it is not a safe non-negative integer
 */
export function requireIntegerId(argumentName, id) {
  const numericId = typeof id === "string" && /^\d+$/.test(id.trim()) ? Number(id.trim()) : id;
  if (!Number.isSafeInteger(numericId) || numericId < 0) rejectInput(`\`${argumentName}\` must be a whole number id, got ${JSON.stringify(id)}`);
  return numericId;
}
