import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFreeSlots, mergeBusyIntervals, normalizeWorkingHours } from "../lib/free-slots.mjs";

const isInvalidInput = (error) => error.kind === "invalid_input";
const JAKARTA = "Asia/Jakarta";
// 2026-11-18 is a Wednesday.
const WEDNESDAY = { timeMin: "2026-11-18T00:00:00+07:00", timeMax: "2026-11-19T00:00:00+07:00", timeZone: JAKARTA };

function slotStarts(request) {
  return computeFreeSlots(request).slots.map((slot) => slot.start);
}

function jakartaTimes(day, hours) {
  return hours.map((hour) => `2026-11-${day}T${hour}:00+07:00`);
}

test("an empty working day yields every aligned slot inside the default 09:00-17:00", () => {
  const { slots, truncated } = computeFreeSlots({ ...WEDNESDAY, durationMinutes: 60, slotStepMinutes: 60 });
  assert.deepEqual(
    slots.map((slot) => slot.start),
    jakartaTimes(18, ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"]),
  );
  assert.equal(slots.at(-1).end, "2026-11-18T17:00:00+07:00");
  assert.equal(truncated, false);
});

test("the default step is 30 minutes, so hour-long slots may overlap", () => {
  const starts = slotStarts({ ...WEDNESDAY, durationMinutes: 60 });
  assert.equal(starts[0], "2026-11-18T09:00:00+07:00");
  assert.equal(starts[1], "2026-11-18T09:30:00+07:00");
  assert.equal(starts.at(-1), "2026-11-18T16:00:00+07:00");
  assert.equal(starts.length, 15);
});

test("a busy interval removes the slots it overlaps and the next slot starts on the step grid after it", () => {
  const busy = [{ start: "2026-11-18T10:00:00+07:00", end: "2026-11-18T11:30:00+07:00" }];
  assert.deepEqual(
    slotStarts({ ...WEDNESDAY, durationMinutes: 60, slotStepMinutes: 60, busy }),
    jakartaTimes(18, ["09:00", "12:00", "13:00", "14:00", "15:00", "16:00"]),
  );
  assert.deepEqual(slotStarts({ ...WEDNESDAY, durationMinutes: 60, slotStepMinutes: 30, busy }).slice(0, 3), jakartaTimes(18, ["09:00", "11:30", "12:00"]));
});

test("a slot may end exactly when a busy interval starts and start exactly when one ends", () => {
  const busy = [{ start: "2026-11-18T10:00:00+07:00", end: "2026-11-18T11:00:00+07:00" }];
  const slots = computeFreeSlots({ ...WEDNESDAY, durationMinutes: 60, slotStepMinutes: 60, busy }).slots;
  assert.deepEqual(slots[0], { start: "2026-11-18T09:00:00+07:00", end: "2026-11-18T10:00:00+07:00" });
  assert.equal(slots[1].start, "2026-11-18T11:00:00+07:00");
});

test("buffers keep a gap before and after every busy interval", () => {
  const busy = [{ start: "2026-11-18T10:00:00+07:00", end: "2026-11-18T11:00:00+07:00" }];
  const starts = slotStarts({ ...WEDNESDAY, durationMinutes: 30, slotStepMinutes: 15, bufferMinutes: 15, busy });
  assert.deepEqual(starts.slice(0, 4), jakartaTimes(18, ["09:00", "09:15", "11:15", "11:30"]));
});

test("overlapping and abutting busy intervals from several calendars merge, in any order", () => {
  const busy = [
    { start: "2026-11-18T12:00:00+07:00", end: "2026-11-18T13:00:00+07:00" },
    { start: "2026-11-18T03:00:00Z", end: "2026-11-18T04:00:00Z" },
    { start: "2026-11-18T10:30:00+07:00", end: "2026-11-18T12:00:00+07:00" },
  ];
  assert.deepEqual(slotStarts({ ...WEDNESDAY, durationMinutes: 60, slotStepMinutes: 60, busy }), jakartaTimes(18, ["09:00", "13:00", "14:00", "15:00", "16:00"]));
});

test("mergeBusyIntervals joins overlaps and touching edges but keeps real gaps", () => {
  const merged = mergeBusyIntervals([
    { startMs: 50, endMs: 60 },
    { startMs: 0, endMs: 10 },
    { startMs: 10, endMs: 20 },
    { startMs: 15, endMs: 18 },
    { startMs: 21, endMs: 30 },
  ]);
  assert.deepEqual(merged, [
    { startMs: 0, endMs: 20 },
    { startMs: 21, endMs: 30 },
    { startMs: 50, endMs: 60 },
  ]);
});

test("working hours are per weekday; days without hours have no slots", () => {
  // Mon 2026-11-16 to Mon 2026-11-23 (exclusive).
  const starts = slotStarts({
    timeMin: "2026-11-16",
    timeMax: "2026-11-23",
    timeZone: JAKARTA,
    durationMinutes: 120,
    slotStepMinutes: 60,
    workingHours: { mon: ["09:00-11:00"], saturday: [{ start: "10:00", end: "12:00" }] },
  });
  assert.deepEqual(starts, ["2026-11-16T09:00:00+07:00", "2026-11-21T10:00:00+07:00"]);
});

test("several windows per day leave the break free of slots", () => {
  const starts = slotStarts({ ...WEDNESDAY, durationMinutes: 60, slotStepMinutes: 60, workingHours: { wed: ["13:00-15:00", "09:00-12:00"] } });
  assert.deepEqual(starts, jakartaTimes(18, ["09:00", "10:00", "11:00", "13:00", "14:00"]));
});

test("a window may run to 24:00", () => {
  const starts = slotStarts({ ...WEDNESDAY, durationMinutes: 60, slotStepMinutes: 60, workingHours: { wed: ["22:00-24:00"] } });
  assert.deepEqual(starts, jakartaTimes(18, ["22:00", "23:00"]));
});

test("the time range clips windows and the first slot stays on the window's step grid", () => {
  const starts = slotStarts({ ...WEDNESDAY, timeMin: "2026-11-18T10:07:00+07:00", timeMax: "2026-11-18T12:00:00+07:00", durationMinutes: 30 });
  assert.deepEqual(starts, jakartaTimes(18, ["10:30", "11:00", "11:30"]));
});

test("a range given in another offset still uses working hours in time_zone", () => {
  const starts = slotStarts({ timeMin: "2026-11-18T00:00:00Z", timeMax: "2026-11-18T04:00:00Z", timeZone: JAKARTA, durationMinutes: 60, slotStepMinutes: 60 });
  assert.deepEqual(starts, jakartaTimes(18, ["09:00", "10:00"]));
});

test("an all-day busy date blocks that whole local day", () => {
  const starts = slotStarts({
    timeMin: "2026-11-18",
    timeMax: "2026-11-21",
    timeZone: JAKARTA,
    durationMinutes: 480,
    slotStepMinutes: 60,
    busy: [{ start: "2026-11-19", end: "2026-11-20" }],
  });
  assert.deepEqual(starts, ["2026-11-18T09:00:00+07:00", "2026-11-20T09:00:00+07:00"]);
});

test("busy time spanning the whole range leaves nothing; busy time outside the range changes nothing", () => {
  const spanning = [{ start: "2026-11-17T00:00:00Z", end: "2026-11-20T00:00:00Z" }];
  assert.deepEqual(slotStarts({ ...WEDNESDAY, durationMinutes: 30, busy: spanning }), []);
  const outside = [{ start: "2026-11-10T00:00:00Z", end: "2026-11-11T00:00:00Z" }];
  assert.equal(slotStarts({ ...WEDNESDAY, durationMinutes: 60, slotStepMinutes: 60, busy: outside }).length, 8);
});

test("a duration longer than every window yields no slots", () => {
  assert.deepEqual(slotStarts({ ...WEDNESDAY, durationMinutes: 600 }), []);
});

test("max slots truncates and says so", () => {
  const { slots, truncated } = computeFreeSlots({ ...WEDNESDAY, durationMinutes: 30, maxSlots: 3 });
  assert.equal(slots.length, 3);
  assert.equal(truncated, true);
});

test("DST fall-back: working hours stay 09:00 local on both sides (America/New_York, 2026-11-01)", () => {
  const everyDay = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((weekday) => [weekday, ["09:00-10:00"]]));
  const { slots } = computeFreeSlots({
    timeMin: "2026-10-31",
    timeMax: "2026-11-03",
    timeZone: "America/New_York",
    durationMinutes: 60,
    workingHours: everyDay,
  });
  assert.deepEqual(slots, [
    { start: "2026-10-31T09:00:00-04:00", end: "2026-10-31T10:00:00-04:00" },
    { start: "2026-11-01T09:00:00-05:00", end: "2026-11-01T10:00:00-05:00" },
    { start: "2026-11-02T09:00:00-05:00", end: "2026-11-02T10:00:00-05:00" },
  ]);
  assert.equal(Date.parse(slots[0].start), Date.parse("2026-10-31T13:00:00Z"));
  assert.equal(Date.parse(slots[1].start), Date.parse("2026-11-01T14:00:00Z"));
});

test("DST spring-forward: a window across the gap is an hour shorter and slots skip the missing hour", () => {
  const { slots } = computeFreeSlots({
    timeMin: "2026-03-08",
    timeMax: "2026-03-09",
    timeZone: "America/New_York",
    durationMinutes: 60,
    slotStepMinutes: 60,
    workingHours: { sun: ["01:00-04:00"] },
  });
  assert.deepEqual(slots, [
    { start: "2026-03-08T01:00:00-05:00", end: "2026-03-08T03:00:00-04:00" },
    { start: "2026-03-08T03:00:00-04:00", end: "2026-03-08T04:00:00-04:00" },
  ]);
});

test("DST spring-forward: a window ending inside the gap ends where the gap ends, not an hour later", () => {
  // America/New_York 2026-03-08 (a Sunday): 02:00 EST jumps to 03:00 EDT, so the window 00:30-02:30 ends at 03:00 EDT.
  const { slots } = computeFreeSlots({
    timeMin: "2026-03-08",
    timeMax: "2026-03-09",
    timeZone: "America/New_York",
    durationMinutes: 60,
    slotStepMinutes: 30,
    workingHours: { sun: ["00:30-02:30"] },
  });
  assert.deepEqual(slots, [
    { start: "2026-03-08T00:30:00-05:00", end: "2026-03-08T01:30:00-05:00" },
    { start: "2026-03-08T01:00:00-05:00", end: "2026-03-08T03:00:00-04:00" },
  ]);
  for (const slot of slots) assert.ok(Date.parse(slot.end) <= Date.parse("2026-03-08T03:00:00-04:00"), slot.end);
});

test("DST spring-forward: a window starting inside the gap still starts after it, shifted by the gap", () => {
  const { slots } = computeFreeSlots({
    timeMin: "2026-03-08",
    timeMax: "2026-03-09",
    timeZone: "America/New_York",
    durationMinutes: 60,
    slotStepMinutes: 60,
    workingHours: { sun: ["02:30-05:00"] },
  });
  assert.deepEqual(slots.map((slot) => slot.start), ["2026-03-08T03:30:00-04:00"]);
});

test("DST fall-back: a window across the repeated hour is an hour longer", () => {
  const { slots } = computeFreeSlots({
    timeMin: "2026-11-01",
    timeMax: "2026-11-02",
    timeZone: "America/New_York",
    durationMinutes: 60,
    slotStepMinutes: 60,
    workingHours: { sun: ["00:00-03:00"] },
  });
  assert.deepEqual(
    slots.map((slot) => slot.start),
    ["2026-11-01T00:00:00-04:00", "2026-11-01T01:00:00-04:00", "2026-11-01T01:00:00-05:00", "2026-11-01T02:00:00-05:00"],
  );
});

test("DST in Europe/Berlin (2026-03-29): 09:00 local is 08:00Z before and 07:00Z after", () => {
  const { slots } = computeFreeSlots({
    timeMin: "2026-03-28",
    timeMax: "2026-03-30",
    timeZone: "Europe/Berlin",
    durationMinutes: 60,
    slotStepMinutes: 60,
    workingHours: { sat: ["09:00-10:00"], sun: ["09:00-10:00"] },
  });
  assert.deepEqual(slots.map((slot) => new Date(Date.parse(slot.start)).toISOString()), ["2026-03-28T08:00:00.000Z", "2026-03-29T07:00:00.000Z"]);
});

test("a busy interval during the repeated DST hour blocks the right occurrence", () => {
  // 01:00-02:00 EST (the second 01:00) is 06:00Z-07:00Z.
  const { slots } = computeFreeSlots({
    timeMin: "2026-11-01",
    timeMax: "2026-11-02",
    timeZone: "America/New_York",
    durationMinutes: 60,
    slotStepMinutes: 60,
    workingHours: { sun: ["00:00-03:00"] },
    busy: [{ start: "2026-11-01T06:00:00Z", end: "2026-11-01T07:00:00Z" }],
  });
  assert.deepEqual(slots.map((slot) => slot.start), ["2026-11-01T00:00:00-04:00", "2026-11-01T01:00:00-04:00", "2026-11-01T02:00:00-05:00"]);
});

test("invalid requests are invalid_input with a useful message", () => {
  const invalidRequests = [
    [{ durationMinutes: 0 }, /duration/],
    [{ durationMinutes: 30, slotStepMinutes: 0 }, /step/],
    [{ durationMinutes: 30, bufferMinutes: -5 }, /buffer/],
    [{ durationMinutes: 30, timeMax: WEDNESDAY.timeMin }, /after/],
    [{ durationMinutes: 30, timeMax: "2027-03-01T00:00:00Z" }, /62 days/],
    [{ durationMinutes: 30, timeZone: "Nowhere/City" }, /time zone/],
    [{ durationMinutes: 30, workingHours: { wed: ["9-17"] } }, /HH:MM-HH:MM/],
    [{ durationMinutes: 30, workingHours: { wed: ["17:00-09:00"] } }, /before/],
    [{ durationMinutes: 30, workingHours: { wed: ["09:00-12:00", "11:00-13:00"] } }, /overlap/],
    [{ durationMinutes: 30, workingHours: { funday: ["09:00-12:00"] } }, /funday/],
    [{ durationMinutes: 30, workingHours: { wed: "09:00-17:00" } }, /list/],
    [{ durationMinutes: 30, workingHours: { wed: ["24:00-24:30"] } }, /HH:MM/],
    [{ durationMinutes: 30, busy: [{ start: "2026-11-18T11:00:00Z", end: "2026-11-18T10:00:00Z" }] }, /busy\[0\]/],
    [{ durationMinutes: 30, busy: [{ start: "2026-11-18T11:00:00Z" }] }, /busy\[0\]\.end/],
    [{ durationMinutes: 30, maxSlots: 0 }, /max slots/i],
    [{ durationMinutes: 30, maxSlots: -3 }, /max slots/i],
    [{ durationMinutes: 30, maxSlots: 2.5 }, /max slots/i],
    [{ durationMinutes: 30, maxSlots: "5" }, /max slots/i],
  ];
  for (const [overrides, expectedMessage] of invalidRequests) {
    assert.throws(
      () => computeFreeSlots({ ...WEDNESDAY, ...overrides }),
      (error) => isInvalidInput(error) && expectedMessage.test(error.message),
      JSON.stringify(overrides),
    );
  }
});

test("normalizeWorkingHours accepts short and long day names and sorts windows", () => {
  const byWeekday = normalizeWorkingHours({ Monday: ["13:00-14:00", "08:30-09:00"], sun: [] });
  assert.deepEqual(byWeekday[1], [
    { startMinutes: 510, endMinutes: 540 },
    { startMinutes: 780, endMinutes: 840 },
  ]);
  assert.deepEqual(byWeekday[0], []);
  assert.deepEqual(byWeekday[2], []);
});
