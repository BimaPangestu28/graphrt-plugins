/**
 * Argument checks that the JSON-schema subset in shared/params cannot express.
 */
import { rejectInput } from "./client.mjs";

// Unix seconds stay below 1e11 until the year 5138; a larger value is almost certainly milliseconds.
const MAX_UNIX_SECONDS = 1e11;
const NUMERIC_ID_PATTERN = /^\d{1,20}$/;

/**
 * Checks an optional Unix timestamp in seconds (not milliseconds).
 *
 * @param argumentName - Argument name for the error message (string)
 * @param timestamp - Value to check (number | undefined)
 * @returns The timestamp, or undefined when absent (number | undefined)
 * @throws PluginError kind `invalid_input` - When it is not a positive whole number of seconds
 */
export function optionalUnixSeconds(argumentName, timestamp) {
  if (timestamp === undefined) return undefined;
  if (!Number.isInteger(timestamp) || timestamp <= 0 || timestamp >= MAX_UNIX_SECONDS) {
    rejectInput(`\`${argumentName}\` must be a Unix timestamp in seconds (10 digits), got ${JSON.stringify(timestamp)}`);
  }
  return timestamp;
}

/**
 * Checks that a time range is not reversed when both ends are given.
 *
 * @param range - `{fromName, from, toName, to}` (object)
 * @throws PluginError kind `invalid_input` - When `to` is not after `from`
 */
export function requireOrderedRange({ fromName, from, toName, to }) {
  if (from !== undefined && to !== undefined && to <= from) rejectInput(`\`${toName}\` must be after \`${fromName}\``);
}

/**
 * Checks a list of numeric TikTok Shop ids (order, product, SKU ids are 64-bit integers sent as strings).
 *
 * @param argumentName - Argument name for errors (string)
 * @param ids - Ids (Array<string>)
 * @param maxCount - Largest allowed count (number)
 * @returns Trimmed ids (Array<string>)
 * @throws PluginError kind `invalid_input` - When the list is empty, too long or has a non-numeric id
 */
export function requireNumericIds(argumentName, ids, maxCount) {
  if (ids.length === 0 || ids.length > maxCount) rejectInput(`\`${argumentName}\` needs 1-${maxCount} ids`);
  return ids.map((id, index) => requireNumericId(`${argumentName}[${index}]`, id));
}

/**
 * Checks one numeric id and returns it as a string (ids exceed JavaScript's safe integer range).
 *
 * @param argumentName - Argument name for errors (string)
 * @param id - Id (string | number)
 * @returns The id as a digit string (string)
 * @throws PluginError kind `invalid_input` - When it is not a string of digits
 */
export function requireNumericId(argumentName, id) {
  const idString = typeof id === "number" && Number.isSafeInteger(id) ? String(id) : typeof id === "string" ? id.trim() : "";
  if (!NUMERIC_ID_PATTERN.test(idString)) rejectInput(`\`${argumentName}\` must be a numeric id (as a string), got ${JSON.stringify(id)}`);
  return idString;
}
