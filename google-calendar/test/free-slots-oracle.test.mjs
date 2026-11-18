/**
 * Seeded randomised check of computeFreeSlots against a brute-force oracle written independently
 * of lib/time-zones.mjs: every grid start in every working window is tried against every busy
 * interval. Deterministic (fixed seeds), so a failure always reproduces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFreeSlots } from "../lib/free-slots.mjs";

const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DEFAULT_WORKING_HOURS = Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((dayName) => [dayName, ["09:00-17:00"]]));
const ZONES = [
  "UTC", "America/New_York", "Europe/London", "Europe/Dublin", "Asia/Kolkata", "Asia/Kathmandu", "America/St_Johns",
  "Australia/Lord_Howe", "Pacific/Chatham", "America/Santiago", "America/Havana", "Asia/Beirut", "Africa/Casablanca",
  "Pacific/Kiritimati", "Pacific/Pago_Pago", "Australia/Adelaide", "Asia/Jakarta", "America/Asuncion",
];
// Days near 2026 DST transitions in the zones above.
const DST_ANCHOR_DAYS = [
  Date.UTC(2026, 2, 7), Date.UTC(2026, 9, 31), Date.UTC(2026, 2, 28), Date.UTC(2026, 9, 24), Date.UTC(2026, 3, 4),
  Date.UTC(2026, 9, 3), Date.UTC(2026, 8, 26), Date.UTC(2026, 8, 5), Date.UTC(2026, 2, 27), Date.UTC(2026, 9, 4),
];
const wallClockFormatters = new Map();

// mulberry32: a small, well-mixed 32-bit generator (Math.imul keeps the arithmetic exact).
function createRandomSource(seed) {
  let state = seed >>> 0;
  const nextFraction = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const nextInteger = (minimum, maximum) => minimum + Math.floor(nextFraction() * (maximum - minimum + 1));
  const pickOne = (choices) => choices[nextInteger(0, choices.length - 1)];
  return { nextFraction, nextInteger, pickOne };
}

const pad = (number) => String(number).padStart(2, "0");

function readWallClock(instantMs, timeZone) {
  let formatter = wallClockFormatters.get(timeZone);
  if (!formatter) {
    const fieldOptions = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" };
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", ...fieldOptions });
    wallClockFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instantMs)).map((part) => [part.type, part.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour % 24, minute: +parts.minute, second: +parts.second };
}

function readWallClockAsUtcMs(instantMs, timeZone) {
  const wall = readWallClock(instantMs, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

function readOffsetAt(instantMs, timeZone) {
  return readWallClockAsUtcMs(instantMs, timeZone) - instantMs;
}

// Earliest instant whose local clock shows the wall time; a skipped time moves later by the gap.
function wallTimeToInstantForStart(wallAsUtcMs, timeZone) {
  const candidateOffsets = new Set();
  for (let hourStep = -48; hourStep <= 48; hourStep += 6) candidateOffsets.add(readOffsetAt(wallAsUtcMs + hourStep * MS_PER_HOUR, timeZone));
  const matches = [...candidateOffsets].map((offsetMs) => wallAsUtcMs - offsetMs).filter((instantMs) => readWallClockAsUtcMs(instantMs, timeZone) === wallAsUtcMs);
  if (matches.length > 0) return { instantMs: Math.min(...matches), isSkipped: false };
  return { instantMs: wallAsUtcMs - readOffsetAt(wallAsUtcMs - MS_PER_DAY, timeZone), isSkipped: true };
}

// First instant at which the local clock has reached the wall time: a skipped end clamps to the gap's end.
function wallTimeToInstantForEnd(wallAsUtcMs, timeZone) {
  const { instantMs, isSkipped } = wallTimeToInstantForStart(wallAsUtcMs, timeZone);
  if (!isSkipped) return instantMs;
  let gapEndMs = instantMs;
  while (readWallClockAsUtcMs(gapEndMs - MS_PER_MINUTE, timeZone) >= wallAsUtcMs) gapEndMs -= MS_PER_MINUTE;
  return gapEndMs;
}

function formatLocal(instantMs, timeZone, isDateOnly) {
  const wall = readWallClock(instantMs, timeZone);
  const datePart = `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
  return isDateOnly ? datePart : `${datePart}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

function formatWithRandomOffset(instantMs, random) {
  const offsetMinutes = random.nextInteger(-12, 13) * 60 + random.pickOne([0, 0, 30, 45]);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const shiftedText = new Date(instantMs + offsetMinutes * MS_PER_MINUTE).toISOString().slice(0, 19);
  return `${shiftedText}${sign}${pad(Math.floor(absoluteMinutes / 60))}:${pad(absoluteMinutes % 60)}`;
}

function generateTimeText(instantMs, timeZone, random) {
  const formatKind = random.nextInteger(0, 3);
  if (formatKind === 0) return new Date(instantMs).toISOString();
  if (formatKind === 1) return formatWithRandomOffset(Math.floor(instantMs / MS_PER_MINUTE) * MS_PER_MINUTE, random);
  return formatLocal(instantMs, timeZone, formatKind === 2);
}

const formatMinutesOfDay = (minutes) => (minutes === 1440 ? "24:00" : `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`);

// latestBoundaryHalfHours caps window edges (48 = any time of day; 12 = 00:00-06:00, where most DST changes happen).
function generateWorkingHours(random, latestBoundaryHalfHours) {
  if (random.nextFraction() < 0.2) return undefined;
  const workingHours = {};
  for (const dayName of DAY_NAMES) {
    if (random.nextFraction() < 0.25) continue;
    const boundaryCount = random.nextInteger(1, 3) * 2;
    const boundaries = Array.from({ length: boundaryCount }, () => random.nextInteger(0, latestBoundaryHalfHours) * 30 + (random.nextFraction() < 0.2 ? random.nextInteger(0, 29) : 0));
    const sortedBoundaries = [...new Set(boundaries)].sort((first, second) => first - second);
    const windows = [];
    for (let index = 0; index + 1 < sortedBoundaries.length; index += 2) {
      const [startMinutes, endMinutes] = [sortedBoundaries[index], Math.min(sortedBoundaries[index + 1], 1440)];
      if (startMinutes < 1440 && endMinutes > startMinutes) windows.push(`${formatMinutesOfDay(startMinutes)}-${formatMinutesOfDay(endMinutes)}`);
    }
    workingHours[dayName] = windows;
  }
  return workingHours;
}

function parseOracleTime(text, timeZone) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return wallTimeToInstantForStart(Date.parse(`${text}T00:00:00Z`), timeZone).instantMs;
  if (/T\d{2}:\d{2}$/.test(text)) return wallTimeToInstantForStart(Date.parse(`${text}:00Z`), timeZone).instantMs;
  return Date.parse(text);
}

function generateRequest(random, { timeZone, rangeStartMs, rangeLengthMs, latestBoundaryHalfHours = 48 }) {
  const timeMin = generateTimeText(rangeStartMs, timeZone, random);
  const timeMax = generateTimeText(rangeStartMs + rangeLengthMs, timeZone, random);
  const [parsedStartMs, parsedEndMs] = [parseOracleTime(timeMin, timeZone), parseOracleTime(timeMax, timeZone)];
  const busy = Array.from({ length: random.nextInteger(0, 12) }, () => {
    const busyStartMs = parsedStartMs - MS_PER_DAY + random.nextInteger(0, Math.max(1, (parsedEndMs - parsedStartMs) / MS_PER_MINUTE + 2880)) * MS_PER_MINUTE;
    if (random.nextFraction() < 0.15) return { start: formatLocal(busyStartMs, timeZone, true), end: formatLocal(busyStartMs + random.nextInteger(1, 3) * MS_PER_DAY, timeZone, true) };
    return { start: generateTimeText(busyStartMs, timeZone, random), end: generateTimeText(busyStartMs + random.nextInteger(1, 600) * MS_PER_MINUTE, timeZone, random) };
  });
  return {
    timeMin,
    timeMax,
    timeZone,
    durationMinutes: random.pickOne([15, 30, 45, 60, 90, 25, 7, 120, random.nextInteger(1, 600)]),
    slotStepMinutes: random.pickOne([undefined, 15, 30, 7, 45, 60, random.nextInteger(1, 200)]),
    bufferMinutes: random.pickOne([undefined, 0, 5, 10, 15, random.nextInteger(0, 120)]),
    workingHours: generateWorkingHours(random, latestBoundaryHalfHours),
    busy,
    maxSlots: random.pickOne([undefined, 5, 50, 200, 100000]),
  };
}

function listOracleWindows(request, rangeStartMs, rangeEndMs) {
  const windowsByWeekday = Array.from({ length: 7 }, () => []);
  for (const [dayName, windowTexts] of Object.entries(request.workingHours ?? DEFAULT_WORKING_HOURS)) {
    for (const windowText of windowTexts) {
      const [startMinutes, endMinutes] = windowText.split("-").map((part) => Number(part.slice(0, 2)) * 60 + Number(part.slice(3)));
      windowsByWeekday[DAY_NAMES.indexOf(dayName)].push([startMinutes, endMinutes]);
    }
  }
  const firstDay = readWallClock(rangeStartMs, request.timeZone);
  const lastDay = readWallClock(rangeEndMs, request.timeZone);
  const windows = [];
  for (let dayUtcMs = Date.UTC(firstDay.year, firstDay.month - 1, firstDay.day); dayUtcMs <= Date.UTC(lastDay.year, lastDay.month - 1, lastDay.day); dayUtcMs += MS_PER_DAY) {
    for (const [startMinutes, endMinutes] of windowsByWeekday[new Date(dayUtcMs).getUTCDay()]) {
      const windowStartMs = wallTimeToInstantForStart(dayUtcMs + startMinutes * MS_PER_MINUTE, request.timeZone).instantMs;
      windows.push([windowStartMs, wallTimeToInstantForEnd(dayUtcMs + endMinutes * MS_PER_MINUTE, request.timeZone)]);
    }
  }
  return windows;
}

function computeExpectedSlotStarts(request) {
  const [rangeStartMs, rangeEndMs] = [parseOracleTime(request.timeMin, request.timeZone), parseOracleTime(request.timeMax, request.timeZone)];
  const [stepMs, durationMs, bufferMs] = [(request.slotStepMinutes ?? 30) * MS_PER_MINUTE, request.durationMinutes * MS_PER_MINUTE, (request.bufferMinutes ?? 0) * MS_PER_MINUTE];
  const busyIntervals = request.busy.map((busyEntry) => [parseOracleTime(busyEntry.start, request.timeZone) - bufferMs, parseOracleTime(busyEntry.end, request.timeZone) + bufferMs]);
  const expectedStarts = [];
  for (const [windowStartMs, windowEndMs] of listOracleWindows(request, rangeStartMs, rangeEndMs)) {
    for (let slotStartMs = windowStartMs; slotStartMs + durationMs <= Math.min(windowEndMs, rangeEndMs); slotStartMs += stepMs) {
      const overlapsBusy = busyIntervals.some(([busyStartMs, busyEndMs]) => busyStartMs < slotStartMs + durationMs && busyEndMs > slotStartMs);
      if (slotStartMs >= rangeStartMs && !overlapsBusy) expectedStarts.push(slotStartMs);
    }
  }
  return expectedStarts.sort((first, second) => first - second);
}

function assertMatchesOracle(request) {
  let result;
  try {
    result = computeFreeSlots(request);
  } catch (error) {
    if (error.kind === "invalid_input") return false;
    throw error;
  }
  const expectedStarts = computeExpectedSlotStarts(request);
  const maxSlots = request.maxSlots ?? 50;
  const label = JSON.stringify(request);
  assert.deepEqual(result.slots.map((slot) => Date.parse(slot.start)), expectedStarts.slice(0, maxSlots), label);
  assert.equal(result.truncated, expectedStarts.length > maxSlots, label);
  for (const slot of result.slots) {
    assert.equal(Date.parse(slot.end) - Date.parse(slot.start), request.durationMinutes * MS_PER_MINUTE, label);
    assert.ok(slot.start.startsWith(formatLocal(Date.parse(slot.start), request.timeZone, false)), `${slot.start} is not local wall time; ${label}`);
  }
  return true;
}

function runOracleCases({ seed, caseCount, chooseRange }) {
  const random = createRandomSource(seed);
  let checkedCount = 0;
  for (let caseIndex = 0; caseIndex < caseCount; caseIndex += 1) {
    const timeZone = random.pickOne(ZONES);
    if (assertMatchesOracle(generateRequest(random, { timeZone, ...chooseRange(random) }))) checkedCount += 1;
  }
  return checkedCount;
}

test("seeded random requests across many zones match a brute-force oracle", () => {
  const checkedCount = runOracleCases({
    seed: 1,
    caseCount: 120,
    chooseRange: (random) => ({
      rangeStartMs: Date.UTC(2026, 0, 1) + random.nextInteger(0, 364) * MS_PER_DAY + random.nextInteger(0, 1439) * MS_PER_MINUTE,
      rangeLengthMs: random.nextInteger(1, 4 * 1440) * MS_PER_MINUTE,
    }),
  });
  assert.ok(checkedCount >= 40, `only ${checkedCount} valid cases`);
});

test("seeded random requests around DST transitions match a brute-force oracle", () => {
  const checkedCount = runOracleCases({
    seed: 16,
    caseCount: 200,
    chooseRange: (random) => ({
      rangeStartMs: random.pickOne(DST_ANCHOR_DAYS) + random.nextInteger(-1440, 1440) * MS_PER_MINUTE,
      rangeLengthMs: random.nextInteger(1, 3 * 1440) * MS_PER_MINUTE,
      latestBoundaryHalfHours: random.pickOne([12, 48]),
    }),
  });
  assert.ok(checkedCount >= 60, `only ${checkedCount} valid cases`);
});
