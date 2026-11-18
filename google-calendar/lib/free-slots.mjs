/**
 * Free-slot search: a pure function from busy intervals, a time range and working hours
 * to candidate meeting slots. No I/O; `find_free_slots` feeds it Google free/busy data.
 *
 * Rules:
 * - Working hours are wall-clock windows per weekday in `timeZone`, so 09:00 stays 09:00 local
 *   across DST changes. A window crossing a DST gap is shorter and one crossing a repeated hour
 *   is longer. A window START skipped by a gap moves later by the gap (02:30 becomes 03:30); a
 *   window END skipped by a gap is clamped to where the gap ends (02:30 becomes 03:00), so no slot
 *   ends later than the clock reaching the window end. Repeated times resolve to their first occurrence.
 * - Slot starts sit on a grid of `slotStepMinutes` from the window's start (09:00, 09:30, ...),
 *   also after a busy interval and when the range starts mid-window.
 * - Busy intervals are widened by `bufferMinutes` on both sides, then overlapping or touching
 *   ones are merged. A slot may end exactly when (widened) busy time starts.
 * - Durations are real elapsed minutes.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import {
  addDays,
  assertValidTimeZone,
  formatInstantInTimeZone,
  parseCalendarDate,
  parseInstant,
  readWallTime,
  wallTimeToInstantMs,
} from "./time-zones.mjs";

export const MAX_RANGE_DAYS = 62;
export const DEFAULT_WORKING_HOURS = Object.freeze(
  Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((weekday) => [weekday, ["09:00-17:00"]])),
);
const DEFAULT_MAX_SLOTS = 50;
const MS_PER_MINUTE = 60000;
const MINUTES_PER_DAY = 1440;
const WEEKDAY_ALIASES = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const WINDOW_PATTERN = /^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Finds free slots of a given length inside working hours.
 *
 * @param request - Search request (object)
 * @param request.timeMin - Range start: RFC 3339, or a local date/date-time read in timeZone (string)
 * @param request.timeMax - Range end, exclusive (string)
 * @param request.timeZone - IANA zone for working hours, dates and the output offsets (string)
 * @param request.durationMinutes - Slot length (number)
 * @param request.busy - `[{start, end}]`; date-times, or dates ("2026-11-19" to "2026-11-20") for all-day busy time (Array, optional)
 * @param request.workingHours - `{mon: ["09:00-17:00"], ...}`; missing days have no hours (object, default Mon-Fri 09:00-17:00)
 * @param request.bufferMinutes - Gap kept before and after busy time (number, default 0)
 * @param request.slotStepMinutes - Grid between candidate starts (number, default 30)
 * @param request.maxSlots - Stop after this many slots (number, default 50)
 * @returns `{slots: [{start, end}], truncated}`; times are RFC 3339 with the zone's offset (object)
 * @throws PluginError kind `invalid_input` - For bad zones, ranges, hours or busy intervals
 *
 * @example
 * computeFreeSlots({ timeMin: "2026-11-18", timeMax: "2026-11-19", timeZone: "Asia/Jakarta", durationMinutes: 60 });
 * // { slots: [{ start: "2026-11-18T09:00:00+07:00", end: "2026-11-18T10:00:00+07:00" }, ...], truncated: false }
 */
export function computeFreeSlots(request) {
  const settings = normalizeSearchSettings(request);
  const busyIntervals = mergeBusyIntervals(
    (request.busy ?? []).map((busyEntry, index) => widenInterval(parseBusyInterval(busyEntry, index, settings.timeZone), settings.bufferMs)),
  );
  const slotIntervals = [];
  let busyIndex = 0;
  for (const window of listWorkingWindows(settings)) {
    busyIndex = collectWindowSlots({ window, busyIntervals, busyIndex, settings, slotIntervals });
    if (slotIntervals.length > settings.maxSlots) break;
  }
  const truncated = slotIntervals.length > settings.maxSlots;
  const slots = slotIntervals.slice(0, settings.maxSlots).map((slot) => ({
    start: formatInstantInTimeZone(slot.startMs, settings.timeZone),
    end: formatInstantInTimeZone(slot.endMs, settings.timeZone),
  }));
  return { slots, truncated };
}

function normalizeSearchSettings(request) {
  const timeZone = assertValidTimeZone(request.timeZone);
  const durationMinutes = requirePositiveMinutes(request.durationMinutes, "duration", MINUTES_PER_DAY);
  const slotStepMinutes = requirePositiveMinutes(request.slotStepMinutes ?? 30, "slot step", MINUTES_PER_DAY);
  const bufferMinutes = request.bufferMinutes ?? 0;
  if (!Number.isInteger(bufferMinutes) || bufferMinutes < 0 || bufferMinutes > MINUTES_PER_DAY) {
    rejectInput(`The buffer must be a whole number of minutes from 0 to ${MINUTES_PER_DAY}`);
  }
  const rangeStartMs = parseInstant(request.timeMin, { name: "time_min", timeZone });
  const rangeEndMs = parseInstant(request.timeMax, { name: "time_max", timeZone });
  if (rangeEndMs <= rangeStartMs) rejectInput("`time_max` must be after `time_min`");
  if (rangeEndMs - rangeStartMs > MAX_RANGE_DAYS * MINUTES_PER_DAY * MS_PER_MINUTE) rejectInput(`The time range may span at most ${MAX_RANGE_DAYS} days`);
  return {
    timeZone,
    rangeStartMs,
    rangeEndMs,
    durationMs: durationMinutes * MS_PER_MINUTE,
    stepMs: slotStepMinutes * MS_PER_MINUTE,
    bufferMs: bufferMinutes * MS_PER_MINUTE,
    maxSlots: requirePositiveCount(request.maxSlots ?? DEFAULT_MAX_SLOTS, "max slots"),
    windowsByWeekday: normalizeWorkingHours(request.workingHours ?? DEFAULT_WORKING_HOURS),
  };
}

function requirePositiveCount(count, label) {
  if (!Number.isInteger(count) || count < 1) rejectInput(`The ${label} must be a whole number of at least 1`);
  return count;
}

function requirePositiveMinutes(minutes, label, maximum) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > maximum) rejectInput(`The ${label} must be a whole number of minutes from 1 to ${maximum}`);
  return minutes;
}

/**
 * Validates working hours and turns them into sorted minute windows per weekday.
 *
 * @param workingHours - `{mon: ["09:00-12:00", {start: "13:00", end: "17:00"}], ...}`; keys are
 *   short or long English day names, any case; "24:00" is allowed as an end (object)
 * @returns Array indexed by weekday (0 = Sunday) of `[{startMinutes, endMinutes}]` (Array)
 * @throws PluginError kind `invalid_input`
 */
export function normalizeWorkingHours(workingHours) {
  if (!workingHours || typeof workingHours !== "object" || Array.isArray(workingHours)) {
    rejectInput('`working_hours` must be an object like {"mon": ["09:00-17:00"]}');
  }
  const windowsByWeekday = Array.from({ length: 7 }, () => []);
  for (const [dayName, dayWindows] of Object.entries(workingHours)) {
    const weekday = WEEKDAY_ALIASES[dayName.toLowerCase()];
    if (weekday === undefined) rejectInput(`Unknown day ${JSON.stringify(dayName)} in \`working_hours\`: use mon, tue, wed, thu, fri, sat or sun`);
    if (!Array.isArray(dayWindows)) rejectInput(`\`working_hours.${dayName}\` must be a list of windows like ["09:00-17:00"]`);
    windowsByWeekday[weekday].push(...dayWindows.map((dayWindow) => parseWindow(dayWindow, dayName)));
  }
  windowsByWeekday.forEach((dayWindows, weekday) => assertNoOverlap(dayWindows.sort((first, second) => first.startMinutes - second.startMinutes), weekday));
  return windowsByWeekday;
}

function parseWindow(dayWindow, dayName) {
  const windowText = typeof dayWindow === "string" ? dayWindow.trim() : `${dayWindow?.start}-${dayWindow?.end}`;
  const match = WINDOW_PATTERN.exec(windowText);
  const startMinutes = match ? toMinutesOfDay(match[1], match[2], false) : undefined;
  const endMinutes = match ? toMinutesOfDay(match[3], match[4], true) : undefined;
  if (startMinutes === undefined || endMinutes === undefined) {
    rejectInput(`Bad window ${JSON.stringify(dayWindow)} in \`working_hours.${dayName}\`: use "HH:MM-HH:MM" (24-hour, end may be 24:00)`);
  }
  if (endMinutes <= startMinutes) rejectInput(`Window ${JSON.stringify(windowText)} in \`working_hours.${dayName}\` must start before it ends`);
  return { startMinutes, endMinutes };
}

function toMinutesOfDay(hourText, minuteText, isEnd) {
  const [hour, minute] = [Number(hourText), Number(minuteText)];
  if (isEnd && hour === 24 && minute === 0) return MINUTES_PER_DAY;
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : undefined;
}

function assertNoOverlap(sortedWindows, weekday) {
  for (let index = 1; index < sortedWindows.length; index += 1) {
    if (sortedWindows[index].startMinutes < sortedWindows[index - 1].endMinutes) {
      const dayName = Object.keys(WEEKDAY_ALIASES).find((alias) => WEEKDAY_ALIASES[alias] === weekday);
      rejectInput(`Windows in \`working_hours.${dayName}\` overlap`);
    }
  }
}

function parseBusyInterval(busyEntry, index, timeZone) {
  const name = `busy[${index}]`;
  for (const edge of ["start", "end"]) {
    if (typeof busyEntry?.[edge] !== "string") rejectInput(`\`${name}.${edge}\` must be a date-time or date string`);
  }
  const startMs = parseBusyEdge(busyEntry.start, `${name}.start`, timeZone);
  const endMs = parseBusyEdge(busyEntry.end, `${name}.end`, timeZone);
  if (endMs <= startMs) rejectInput(`\`${name}\` must end after it starts`);
  return { startMs, endMs };
}

// A date means local midnight in the search's zone, so "2026-11-19".."2026-11-20" blocks that local day.
function parseBusyEdge(value, name, timeZone) {
  if (!DATE_ONLY_PATTERN.test(value.trim())) return parseInstant(value, { name, timeZone });
  return wallTimeToInstantMs({ ...parseCalendarDate(value, name), hour: 0, minute: 0 }, timeZone);
}

function widenInterval(interval, bufferMs) {
  return { startMs: interval.startMs - bufferMs, endMs: interval.endMs + bufferMs };
}

/**
 * Sorts intervals and merges the ones that overlap or touch.
 *
 * @param intervals - `[{startMs, endMs}]` in any order (Array)
 * @returns New sorted, disjoint `[{startMs, endMs}]` with gaps between neighbours (Array)
 */
export function mergeBusyIntervals(intervals) {
  const sortedIntervals = [...intervals].sort((first, second) => first.startMs - second.startMs);
  const mergedIntervals = [];
  for (const interval of sortedIntervals) {
    const previous = mergedIntervals.at(-1);
    if (previous && interval.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, interval.endMs);
    else mergedIntervals.push({ ...interval });
  }
  return mergedIntervals;
}

// Working windows as absolute instants, in time order, for every local date the range touches.
function listWorkingWindows({ timeZone, rangeStartMs, rangeEndMs, windowsByWeekday }) {
  const workingWindows = [];
  const lastDate = readWallTime(rangeEndMs, timeZone);
  for (let localDate = readWallTime(rangeStartMs, timeZone); compareDates(localDate, lastDate) <= 0; localDate = addDays(localDate, 1)) {
    const weekday = new Date(Date.UTC(localDate.year, localDate.month - 1, localDate.day)).getUTCDay();
    for (const { startMinutes, endMinutes } of windowsByWeekday[weekday]) {
      const windowStartMs = minutesIntoDayToInstant(localDate, startMinutes, timeZone, "shiftLater");
      const windowEndMs = minutesIntoDayToInstant(localDate, endMinutes, timeZone, "gapEnd");
      workingWindows.push({ windowStartMs, clippedStartMs: Math.max(windowStartMs, rangeStartMs), clippedEndMs: Math.min(windowEndMs, rangeEndMs) });
    }
  }
  return workingWindows;
}

function minutesIntoDayToInstant(localDate, minutesOfDay, timeZone, skippedTime) {
  const dayStart = { year: localDate.year, month: localDate.month, day: localDate.day };
  const wallTime = minutesOfDay === MINUTES_PER_DAY
    ? { ...addDays(dayStart, 1), hour: 0, minute: 0 }
    : { ...dayStart, hour: Math.floor(minutesOfDay / 60), minute: minutesOfDay % 60 };
  return wallTimeToInstantMs(wallTime, timeZone, { skippedTime });
}

function compareDates(first, second) {
  return Date.UTC(first.year, first.month - 1, first.day) - Date.UTC(second.year, second.month - 1, second.day);
}

// Adds the window's slots to slotIntervals (one more than maxSlots at most) and returns the busy index to resume from.
function collectWindowSlots({ window, busyIntervals, busyIndex, settings, slotIntervals }) {
  const { durationMs, stepMs, maxSlots } = settings;
  const alignToGrid = (instantMs) => window.windowStartMs + Math.ceil((instantMs - window.windowStartMs) / stepMs) * stepMs;
  let candidateStartMs = alignToGrid(window.clippedStartMs);
  let nextBusyIndex = busyIndex;
  while (candidateStartMs + durationMs <= window.clippedEndMs && slotIntervals.length <= maxSlots) {
    while (nextBusyIndex < busyIntervals.length && busyIntervals[nextBusyIndex].endMs <= candidateStartMs) nextBusyIndex += 1;
    const blockingInterval = busyIntervals[nextBusyIndex];
    if (blockingInterval && blockingInterval.startMs < candidateStartMs + durationMs) {
      candidateStartMs = alignToGrid(blockingInterval.endMs);
      continue;
    }
    slotIntervals.push({ startMs: candidateStartMs, endMs: candidateStartMs + durationMs });
    candidateStartMs += stepMs;
  }
  return nextBusyIndex;
}

function rejectInput(message) {
  throw new PluginError(message, { kind: "invalid_input" });
}
