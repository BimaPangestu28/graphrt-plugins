/**
 * Pure date logic for Indonesian holidays: validating and normalizing upstream records, describing one date, counting
 * working days (Monday to Friday minus holidays) and picking upcoming holidays. Dates are calendar dates in
 * Asia/Jakarta, handled as UTC midnights so no local time zone or DST can shift them.
 *
 * Cuti bersama coverage: the source sometimes lists a year's national holidays before its cuti bersama days are
 * decided (and future SKBs are amended), so a year with no cuti bersama records, or after the current year, is
 * "not known": a plain weekday then has `is_working_day: null` and working-day counts are flagged `uncertain`.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const DAY_MS = 24 * 3600 * 1000;
const JAKARTA_OFFSET_MS = 7 * 3600 * 1000;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
export const FIRST_YEAR = 2011;
export const LAST_YEAR = 2100;

/**
 * Adds `kind` to an upstream holiday record: national holidays (libur nasional) or collective leave (cuti bersama).
 *
 * @param holiday - `{name, date, is_national_holiday}` from the source (object)
 * @returns `{date, name, is_national_holiday, kind}` (object)
 */
export function normalizeHoliday(holiday) {
  const isNational = holiday?.is_national_holiday === true;
  return { date: holiday?.date, name: holiday?.name, is_national_holiday: isNational, kind: isNational ? "libur_nasional" : "cuti_bersama" };
}

function splitRealIsoDate(dateText) {
  const match = ISO_DATE_PATTERN.exec(String(dateText ?? ""));
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number);
  // setUTCFullYear, unlike Date.UTC, does not map years 0-99 to 1900-1999.
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return undefined;
  return { year, month, day };
}

/**
 * Keeps only well-formed upstream records (a real YYYY-MM-DD date in the requested year, a non-empty string name and
 * a boolean is_national_holiday)
 * and normalizes them, so a malformed item is never cached, listed or counted.
 *
 * @param records - Upstream items (unknown[])
 * @param year - Requested year (number)
 * @returns Normalized holidays (object[])
 */
export function sanitizeHolidayRecords(records, year) {
  const isValid = (record) =>
    record !== null &&
    typeof record === "object" &&
    typeof record.name === "string" &&
    record.name.trim() !== "" &&
    typeof record.is_national_holiday === "boolean" &&
    splitRealIsoDate(record.date)?.year === year;
  return records.filter(isValid).map(normalizeHoliday);
}

/**
 * Whether a year's cuti bersama days can be relied on: the source lists some, and the year is not after the current
 * one (a future year's SKB may be missing or amended).
 *
 * @param year - Year (number)
 * @param holidays - Normalized holidays of that year (object[])
 * @param currentYear - Current year in Asia/Jakarta (number)
 * @returns Whether cuti bersama data is known (boolean)
 */
export function isCutiBersamaKnown(year, holidays, currentYear) {
  return year <= currentYear && holidays.some((holiday) => holiday.kind === "cuti_bersama");
}

/**
 * Explains why a result is uncertain.
 *
 * @param years - Years whose cuti bersama days are not known (number[])
 * @returns Note text (string)
 */
export function describeUnknownCutiBersama(years) {
  return (
    `Cuti bersama for ${years.join(", ")} is not known yet (not published by the source, or not final for a future year); ` +
    "a weekday that is not a national holiday may still become cuti bersama"
  );
}

/**
 * Parses a YYYY-MM-DD calendar date and checks that it exists and lies in the supported years.
 *
 * @param dateText - The date (string)
 * @param argumentName - Parameter name for the error message (string)
 * @returns `{year, month, day, text}` (object)
 * @throws PluginError kind `invalid_input` - Not YYYY-MM-DD, not a real date, or the year is outside 2011..2100
 */
export function parseIsoDate(dateText, argumentName) {
  const parts = splitRealIsoDate(dateText);
  if (!parts) {
    throw new PluginError(`\`${argumentName}\` must be a real date as YYYY-MM-DD; got ${JSON.stringify(dateText)}`, { kind: "invalid_input" });
  }
  if (parts.year < FIRST_YEAR || parts.year > LAST_YEAR) {
    throw new PluginError(`\`${argumentName}\` must be in the years ${FIRST_YEAR} to ${LAST_YEAR}; got ${dateText}`, { kind: "invalid_input" });
  }
  return { ...parts, text: dateText };
}

/**
 * Today's date in Asia/Jakarta (UTC+7, no DST).
 *
 * @param nowMs - Current time in milliseconds (number, default Date.now())
 * @returns YYYY-MM-DD (string)
 */
export function jakartaToday(nowMs = Date.now()) {
  return new Date(nowMs + JAKARTA_OFFSET_MS).toISOString().slice(0, 10);
}

function dayIndexOf(dateText) {
  return new Date(`${dateText}T00:00:00Z`).getUTCDay();
}

function isWeekend(dateText) {
  const dayIndex = dayIndexOf(dateText);
  return dayIndex === 0 || dayIndex === 6;
}

/**
 * Describes one date against a holiday list.
 *
 * @param dateText - YYYY-MM-DD (string)
 * @param holidays - Normalized holidays of that year (object[])
 * @param options - `{cutiBersamaKnown}` (object, default true); when false, a weekday that is neither a national
 *   holiday nor listed cuti bersama gets `is_working_day: null` and a `note`
 * @returns `{date, day_of_week, hari, is_weekend, is_holiday, is_national_holiday, is_cuti_bersama, is_working_day,
 *   cuti_bersama_known, holidays, note?}` (object)
 */
export function describeDate(dateText, holidays, { cutiBersamaKnown = true } = {}) {
  const matches = holidays.filter((holiday) => holiday.date === dateText);
  const isNational = matches.some((holiday) => holiday.kind === "libur_nasional");
  const isCutiBersama = matches.some((holiday) => holiday.kind === "cuti_bersama");
  const weekend = isWeekend(dateText);
  const undecided = !cutiBersamaKnown && !weekend && matches.length === 0;
  return {
    date: dateText,
    day_of_week: DAY_NAMES[dayIndexOf(dateText)],
    hari: HARI[dayIndexOf(dateText)],
    is_weekend: weekend,
    is_holiday: matches.length > 0,
    is_national_holiday: isNational,
    is_cuti_bersama: isCutiBersama,
    is_working_day: undecided ? null : !weekend && matches.length === 0,
    cuti_bersama_known: cutiBersamaKnown,
    holidays: matches.map((holiday) => holiday.name),
    ...(undecided ? { note: describeUnknownCutiBersama([Number(dateText.slice(0, 4))]) } : {}),
  };
}

function describeCountCertainty(unknownCutiBersamaYears, noDataYears) {
  const uncertainYears = [...new Set([...unknownCutiBersamaYears, ...noDataYears])].sort((first, second) => first - second);
  if (uncertainYears.length === 0) return { uncertain: false, uncertain_years: [] };
  const notes = [];
  if (noDataYears.length > 0) notes.push(`the source has no holiday data for ${noDataYears.join(", ")} yet, so no holidays were subtracted there`);
  const cutiOnlyYears = unknownCutiBersamaYears.filter((year) => !noDataYears.includes(year));
  if (cutiOnlyYears.length > 0) notes.push(describeUnknownCutiBersama(cutiOnlyYears));
  return { uncertain: true, uncertain_years: uncertainYears, note: `working_days may be too high: ${notes.join("; ")}` };
}

/**
 * Counts working days (Monday to Friday, not a holiday) from start to end, both included.
 *
 * @param startDate - YYYY-MM-DD (string)
 * @param endDate - YYYY-MM-DD, not before startDate (string)
 * @param holidays - Normalized holidays covering the range (object[])
 * @param options - Count options (object)
 * @param options.cutiBersamaIsDayOff - Count cuti bersama as days off (boolean)
 * @param options.unknownCutiBersamaYears - Years in the range whose cuti bersama days are not known; they make the
 *   count uncertain when cuti bersama counts as days off (number[], default [])
 * @param options.noDataYears - Years in the range the source has no holidays for at all; they always make the count
 *   uncertain (number[], default [])
 * @returns `{start_date, end_date, calendar_days, weekend_days, working_days, days_off_on_weekdays, uncertain,
 *   uncertain_years, note?}` (object)
 */
export function countWorkingDays(startDate, endDate, holidays, { cutiBersamaIsDayOff, unknownCutiBersamaYears = [], noDataYears = [] }) {
  const daysOff = holidays.filter((holiday) => cutiBersamaIsDayOff || holiday.kind === "libur_nasional");
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const calendarDays = Math.round((Date.parse(`${endDate}T00:00:00Z`) - startMs) / DAY_MS) + 1;
  let weekendDays = 0;
  const daysOffOnWeekdays = [];
  for (let offset = 0; offset < calendarDays; offset += 1) {
    const dateText = new Date(startMs + offset * DAY_MS).toISOString().slice(0, 10);
    if (isWeekend(dateText)) {
      weekendDays += 1;
      continue;
    }
    const names = daysOff.filter((holiday) => holiday.date === dateText).map((holiday) => holiday.name);
    if (names.length > 0) daysOffOnWeekdays.push({ date: dateText, holidays: names });
  }
  return {
    start_date: startDate,
    end_date: endDate,
    calendar_days: calendarDays,
    weekend_days: weekendDays,
    working_days: calendarDays - weekendDays - daysOffOnWeekdays.length,
    days_off_on_weekdays: daysOffOnWeekdays,
    ...describeCountCertainty(cutiBersamaIsDayOff ? unknownCutiBersamaYears : [], noDataYears),
  };
}

/**
 * Picks the first holidays on or after a date, in date order.
 *
 * @param holidays - Normalized holidays (object[])
 * @param fromDate - YYYY-MM-DD (string)
 * @param options - `{count, includeCutiBersama}` (object)
 * @returns Holidays (object[])
 */
export function pickUpcoming(holidays, fromDate, { count, includeCutiBersama }) {
  return holidays
    .filter((holiday) => holiday.date >= fromDate && (includeCutiBersama || holiday.kind === "libur_nasional"))
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(0, count);
}
