/**
 * Converts the plugin's simple text formats into Google's Date and TimeOfDay objects.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

/**
 * Parses "YYYY-MM-DD" into `{year, month, day}`.
 *
 * @param dateText - Date text (string)
 * @param argumentName - For error messages (string)
 * @returns Google Date (object)
 * @throws PluginError kind `invalid_input`
 *
 * @example
 * parseDate("2026-12-25", "date"); // { year: 2026, month: 12, day: 25 }
 */
export function parseDate(dateText, argumentName) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText ?? ""));
  const [year, month, day] = dateMatch ? dateMatch.slice(1).map(Number) : [];
  const calendarDate = dateMatch ? new Date(Date.UTC(year, month - 1, day)) : null;
  const isRealDate = calendarDate && calendarDate.getUTCMonth() === month - 1 && calendarDate.getUTCDate() === day;
  if (!isRealDate) rejectFormat(argumentName, "a date YYYY-MM-DD", dateText);
  return { year, month, day };
}

/**
 * Parses "HH:MM" (00:00-24:00) into `{hours, minutes}`.
 *
 * @param timeText - Time text (string)
 * @param argumentName - For error messages (string)
 * @returns Google TimeOfDay (object)
 * @throws PluginError kind `invalid_input`
 *
 * @example
 * parseTimeOfDay("09:30", "open_time"); // { hours: 9, minutes: 30 }
 */
export function parseTimeOfDay(timeText, argumentName) {
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(String(timeText ?? ""));
  const [hours, minutes] = timeMatch ? timeMatch.slice(1).map(Number) : [];
  const isValid = timeMatch && minutes < 60 && (hours < 24 || (hours === 24 && minutes === 0));
  if (!isValid) rejectFormat(argumentName, "a time HH:MM between 00:00 and 24:00", timeText);
  return { hours, minutes };
}

/**
 * Parses "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" into a date and an optional time.
 *
 * @param dateTimeText - Date or date-time text (string)
 * @param argumentName - For error messages (string)
 * @returns `{date, time?}` (object)
 * @throws PluginError kind `invalid_input`
 */
export function parseDateWithOptionalTime(dateTimeText, argumentName) {
  const [datePart, timePart, ...extraParts] = String(dateTimeText ?? "").split("T");
  if (extraParts.length > 0) rejectFormat(argumentName, "YYYY-MM-DD or YYYY-MM-DDTHH:MM", dateTimeText);
  const date = parseDate(datePart, argumentName);
  return timePart === undefined ? { date } : { date, time: parseTimeOfDay(timePart, argumentName) };
}

/**
 * Formats a Google Date as "YYYY-MM-DD".
 *
 * @param googleDate - `{year, month, day}` (object)
 * @returns Date text (string)
 */
export function formatDate(googleDate) {
  const pad = (dateNumber, width) => String(dateNumber ?? 0).padStart(width, "0");
  return `${pad(googleDate?.year, 4)}-${pad(googleDate?.month, 2)}-${pad(googleDate?.day, 2)}`;
}

function rejectFormat(argumentName, expectedFormat, receivedValue) {
  throw new PluginError(`\`${argumentName}\` must be ${expectedFormat}, got ${JSON.stringify(receivedValue)}`, { kind: "invalid_input" });
}
