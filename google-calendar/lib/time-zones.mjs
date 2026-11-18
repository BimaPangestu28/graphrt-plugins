/**
 * IANA time zone arithmetic on top of `Intl.DateTimeFormat` (no dependencies).
 *
 * Instants are epoch milliseconds. A "wall time" is what a clock in the zone shows:
 * `{year, month (1-12), day, hour, minute}`. Converting a wall time to an instant follows
 * the usual "compatible" rule for DST transitions: a time skipped by spring-forward moves
 * later by the length of the gap (02:30 becomes 03:30), and a time repeated by fall-back
 * resolves to its earlier occurrence. Callers converting the END of a span can ask for a skipped
 * time to resolve to the end of the gap instead (02:30 becomes 03:00), so the span never grows.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const MS_PER_MINUTE = 60000;
const MS_PER_DAY = 86400000;
const MAX_OFFSET_MINUTES = 14 * 60;
const WEEKDAY_NUMBERS ={ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/i;
const wallTimeFormatters = new Map();

/**
 * Checks that a value is an IANA time zone name known to this Node runtime.
 *
 * @param timeZone - e.g. "Asia/Jakarta" (string)
 * @returns The same name (string)
 * @throws PluginError kind `invalid_input` - For unknown zones and raw offsets like "+07:00"
 */
export function assertValidTimeZone(timeZone) {
  const isNamedZone = typeof timeZone === "string" && /^[A-Za-z]/.test(timeZone.trim());
  if (isNamedZone) {
    try {
      readFormatter(timeZone);
      return timeZone;
    } catch {
      // Falls through to the error below.
    }
  }
  throw new PluginError(`Unknown time zone ${JSON.stringify(timeZone)}: use an IANA name such as "Asia/Jakarta" or "America/New_York"`, {
    kind: "invalid_input",
  });
}

function readFormatter(timeZone) {
  let formatter = wallTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    wallTimeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Reads the wall-clock parts of an instant in a zone.
 *
 * @param instantMs - Epoch milliseconds (number)
 * @param timeZone - IANA zone (string)
 * @returns `{year, month, day, hour, minute, second, weekday}`; weekday 0 = Sunday (object)
 */
export function readWallTime(instantMs, timeZone) {
  const parts = Object.fromEntries(readFormatter(timeZone).formatToParts(new Date(instantMs)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_NUMBERS[parts.weekday],
  };
}

/**
 * The zone's UTC offset at an instant, in milliseconds (positive east of UTC).
 *
 * @param instantMs - Epoch milliseconds (number)
 * @param timeZone - IANA zone (string)
 * @returns Offset in ms (number)
 */
export function readOffsetMs(instantMs, timeZone) {
  const wholeSecondMs = Math.floor(instantMs / 1000) * 1000;
  const wallTime = readWallTime(wholeSecondMs, timeZone);
  const wallAsUtcMs = Date.UTC(wallTime.year, wallTime.month - 1, wallTime.day, wallTime.hour, wallTime.minute, wallTime.second);
  return wallAsUtcMs - wholeSecondMs;
}

/**
 * Converts a wall time in a zone to an instant (see the module docs for DST gaps and overlaps).
 *
 * @param wallTime - `{year, month, day, hour, minute}`; hour may be 24 for the end of the day (object)
 * @param timeZone - IANA zone (string)
 * @param options - `{skippedTime}`: "shiftLater" (default) moves a skipped time later by the gap;
 *   "gapEnd" resolves it to the instant the gap ends, the first moment the clock has passed it,
 *   which suits the end of a window (object)
 * @returns Epoch milliseconds (number)
 *
 * @example
 * wallTimeToInstantMs({ year: 2026, month: 11, day: 18, hour: 9, minute: 0 }, "Asia/Jakarta"); // 2026-11-18T02:00:00Z
 * wallTimeToInstantMs({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "America/New_York", { skippedTime: "gapEnd" }); // 2026-03-08T07:00:00Z (03:00 EDT)
 */
export function wallTimeToInstantMs({ year, month, day, hour, minute }, timeZone, { skippedTime = "shiftLater" } = {}) {
  const wallAsUtcMs = Date.UTC(year, month - 1, day, hour, minute);
  const offsetBeforeMs = readOffsetMs(wallAsUtcMs - MS_PER_DAY, timeZone);
  const offsetAfterMs = readOffsetMs(wallAsUtcMs + MS_PER_DAY, timeZone);
  const matchingInstants = [...new Set([offsetBeforeMs, offsetAfterMs])]
    .map((offsetMs) => wallAsUtcMs - offsetMs)
    .filter((instantMs) => readOffsetMs(instantMs, timeZone) === wallAsUtcMs - instantMs);
  if (matchingInstants.length > 0) return Math.min(...matchingInstants);
  // Skipped by a spring-forward gap: the offset from before the gap lands after it, the one from after lands before it.
  const shiftedLaterMs = wallAsUtcMs - offsetBeforeMs;
  if (skippedTime !== "gapEnd") return shiftedLaterMs;
  return findTransitionInstantMs(wallAsUtcMs - offsetAfterMs, shiftedLaterMs, timeZone);
}

// Binary search (whole seconds) for the first instant after beforeMs whose offset differs from beforeMs's.
function findTransitionInstantMs(beforeMs, afterMs, timeZone) {
  const offsetBeforeMs = readOffsetMs(beforeMs, timeZone);
  let [lowMs, highMs] = [beforeMs, afterMs];
  while (highMs - lowMs > 1000) {
    const middleMs = lowMs + Math.floor((highMs - lowMs) / 2000) * 1000;
    if (readOffsetMs(middleMs, timeZone) === offsetBeforeMs) lowMs = middleMs;
    else highMs = middleMs;
  }
  return highMs;
}

/**
 * Formats an instant as RFC 3339 with the zone's offset at that instant ("Z" for a zero offset).
 *
 * @param instantMs - Epoch milliseconds (number)
 * @param timeZone - IANA zone (string)
 * @returns e.g. "2026-11-18T09:00:00+07:00" (string)
 */
export function formatInstantInTimeZone(instantMs, timeZone) {
  const wallTime = readWallTime(instantMs, timeZone);
  const offsetMinutes = Math.round(readOffsetMs(instantMs, timeZone) / MS_PER_MINUTE);
  const datePart = `${wallTime.year}-${pad(wallTime.month)}-${pad(wallTime.day)}`;
  const timePart = `${pad(wallTime.hour)}:${pad(wallTime.minute)}:${pad(wallTime.second)}`;
  return `${datePart}T${timePart}${formatOffset(offsetMinutes)}`;
}

function formatOffset(offsetMinutes) {
  if (offsetMinutes === 0) return "Z";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(absoluteMinutes / 60))}:${pad(absoluteMinutes % 60)}`;
}

function pad(number) {
  return String(number).padStart(2, "0");
}

/**
 * Parses a date or date-time. RFC 3339 values with "Z" or an offset are absolute; local date-times
 * ("2026-11-18T09:00") and dates ("2026-11-18", meaning local midnight) need `timeZone`.
 *
 * @param value - The text to parse (string)
 * @param options - `{name, timeZone}`; name is the argument name used in errors (object)
 * @returns Epoch milliseconds (number)
 * @throws PluginError kind `invalid_input` - When malformed, out of range, or local without a time zone
 */
export function parseInstant(value, { name, timeZone }) {
  const { wallTime, second, fractionMs, offset } = parseDateTimeParts(value, name);
  if (offset) {
    const wallAsUtcMs = Date.UTC(wallTime.year, wallTime.month - 1, wallTime.day, wallTime.hour, wallTime.minute, second) + fractionMs;
    return wallAsUtcMs - parseOffsetMs(offset);
  }
  if (!timeZone) {
    throw new PluginError(`\`${name}\` ${JSON.stringify(value)} has no UTC offset: add one (e.g. +07:00 or Z) or pass \`time_zone\``, {
      kind: "invalid_input",
    });
  }
  return wallTimeToInstantMs(wallTime, timeZone) + second * 1000 + fractionMs;
}

/**
 * Rewrites a date-time in the one form sent to Google: "YYYY-MM-DDTHH:MM:SS" plus the given
 * offset ("Z" or "+HH:MM", upper case), or no offset for a local time. Missing seconds become ":00"
 * and fractional seconds are dropped (Calendar times have whole seconds).
 *
 * @param value - e.g. "2026-11-20T09:00" or "2026-11-20t09:00:00.5+07:00" (string)
 * @param name - Argument name for errors (string)
 * @returns e.g. "2026-11-20T09:00:00" or "2026-11-20T09:00:00+07:00" (string)
 * @throws PluginError kind `invalid_input` - When malformed or the offset is out of range
 *
 * @example
 * normalizeDateTimeText("2026-11-20t09:00z", "start"); // "2026-11-20T09:00:00Z"
 */
export function normalizeDateTimeText(value, name) {
  const { wallTime, second, offset } = parseDateTimeParts(value, name);
  const datePart = formatCalendarDate(wallTime);
  const timePart = `${pad(wallTime.hour)}:${pad(wallTime.minute)}:${pad(second)}`;
  return `${datePart}T${timePart}${offset ? offset.toUpperCase() : ""}`;
}

function parseDateTimeParts(value, name) {
  const match = RFC3339_PATTERN.exec(String(value).trim());
  if (!match) throw invalidDateTime(name, value);
  const [, year, month, day, hour = "00", minute = "00", second = "00", fraction = "", offset] = match;
  const wallTime = { year: Number(year), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute) };
  if (!isRealWallTime(wallTime, Number(second))) throw invalidDateTime(name, value);
  if (offset && !isRealOffset(offset)) {
    throw new PluginError(`\`${name}\` ${JSON.stringify(value)} has an impossible UTC offset: use -14:00 to +14:00 with minutes 00-59`, {
      kind: "invalid_input",
    });
  }
  const fractionMs = fraction ? Math.floor(Number(fraction) * 1000) : 0;
  return { wallTime, second: Number(second), fractionMs, offset };
}

function isRealOffset(offset) {
  if (offset.toUpperCase() === "Z") return true;
  const [hours, minutes] = offset.slice(1).split(":").map(Number);
  return minutes <= 59 && hours * 60 + minutes <= MAX_OFFSET_MINUTES;
}

/**
 * Parses a calendar date "YYYY-MM-DD".
 *
 * @param value - Date text (string)
 * @param name - Argument name for errors (string)
 * @returns `{year, month, day}` (object)
 * @throws PluginError kind `invalid_input`
 */
export function parseCalendarDate(value, name) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  const calendarDate = match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : undefined;
  if (!calendarDate || !isRealWallTime({ ...calendarDate, hour: 0, minute: 0 }, 0)) {
    throw new PluginError(`\`${name}\` must be a date like 2026-11-18, got ${JSON.stringify(value)}`, { kind: "invalid_input" });
  }
  return calendarDate;
}

/**
 * Adds days to a calendar date.
 *
 * @param calendarDate - `{year, month, day}` (object)
 * @param dayCount - Days to add, may be negative (number)
 * @returns `{year, month, day}` (object)
 */
export function addDays({ year, month, day }, dayCount) {
  const shifted = new Date(Date.UTC(year, month - 1, day + dayCount));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/**
 * Formats a calendar date as "YYYY-MM-DD".
 *
 * @param calendarDate - `{year, month, day}` (object)
 * @returns Date text (string)
 */
export function formatCalendarDate({ year, month, day }) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function isRealWallTime({ year, month, day, hour, minute }, second) {
  const probe = new Date(Date.UTC(year, month - 1, day));
  const isRealDate = probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
  return isRealDate && hour <= 23 && minute <= 59 && second <= 59;
}

function parseOffsetMs(offset) {
  if (offset.toUpperCase() === "Z") return 0;
  const sign = offset.startsWith("-") ? -1 : 1;
  const [hours, minutes] = offset.slice(1).split(":").map(Number);
  return sign * (hours * 60 + minutes) * MS_PER_MINUTE;
}

function invalidDateTime(name, value) {
  return new PluginError(`\`${name}\` must be an RFC 3339 date-time like 2026-11-18T09:00:00+07:00 or a date like 2026-11-18, got ${JSON.stringify(value)}`, {
    kind: "invalid_input",
  });
}
