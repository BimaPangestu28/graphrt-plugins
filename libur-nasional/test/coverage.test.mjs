import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createTtlCache } from "../lib/holiday-cache.mjs";
import { isCutiBersamaKnown, sanitizeHolidayRecords } from "../lib/holiday-calendar.mjs";
import { createPluginDefinition } from "../definition.mjs";

// 2026 with cuti bersama published; 2027 without (the SKB for 2027 lists no cuti bersama yet).
const YEAR_2026 = [
  { name: "Cuti Bersama Hari Raya Natal", date: "2026-12-24", is_national_holiday: false },
  { name: "Hari Raya Natal", date: "2026-12-25", is_national_holiday: true },
];
const YEAR_2027 = [
  { name: "Tahun Baru 2027 Masehi", date: "2027-01-01", is_national_holiday: true },
  { name: "Isra Mikraj", date: "2027-01-05", is_national_holiday: true },
];

function createRunner({ responses, nowIso = "2026-11-19T03:00:00Z" }) {
  const recordingFetch = createRecordingFetch(responses);
  const definition = createPluginDefinition({ cache: createTtlCache(), now: () => Date.parse(nowIso) });
  const runner = createOperationRunner(definition, {}, { fetchImpl: recordingFetch });
  return { run: (operationName, args, source = "tool") => runner(operationName, args, { source }), calls: recordingFetch.calls };
}

test("isCutiBersamaKnown: false with no cuti bersama records or for a year after the current one", () => {
  assert.equal(isCutiBersamaKnown(2026, [{ kind: "cuti_bersama" }], 2026), true);
  assert.equal(isCutiBersamaKnown(2026, [{ kind: "libur_nasional" }], 2026), false);
  assert.equal(isCutiBersamaKnown(2027, [{ kind: "cuti_bersama" }], 2026), false);
  assert.equal(isCutiBersamaKnown(2025, [{ kind: "cuti_bersama" }], 2026), true);
});

test("sanitizeHolidayRecords drops items without a real YYYY-MM-DD date of that year or a string name", () => {
  const records = [
    { name: "Hari Raya Natal", date: "2026-12-25", is_national_holiday: true },
    { name: "No date", is_national_holiday: true },
    { name: "Bad date", date: "2026-02-30", is_national_holiday: true },
    { name: "Wrong year", date: "2025-12-25", is_national_holiday: true },
    { name: 42, date: "2026-01-01", is_national_holiday: true },
    { name: "Timestamp", date: "2026-01-01T00:00:00Z", is_national_holiday: true },
    null,
    "2026-01-01",
  ];
  assert.deepEqual(sanitizeHolidayRecords(records, 2026).map((holiday) => holiday.name), ["Hari Raya Natal"]);
});

test("check_date: a weekday of a year without cuti bersama data has is_working_day null and a note", async () => {
  const { run } = createRunner({ responses: [{ body: YEAR_2027 }] });
  const ordinaryWeekday = await run("check_date", { date: "2027-01-04" });
  assert.equal(ordinaryWeekday.data.cuti_bersama_known, false);
  assert.equal(ordinaryWeekday.data.is_working_day, null);
  assert.match(ordinaryWeekday.data.note, /cuti bersama.*2027/i);
  const nationalHoliday = await run("check_date", { date: "2027-01-01" });
  assert.equal(nationalHoliday.data.is_working_day, false);
  const weekend = await run("check_date", { date: "2027-01-02" });
  assert.equal(weekend.data.is_working_day, false);
});

test("check_date: a year with cuti bersama data up to the current year is known", async () => {
  const { run } = createRunner({ responses: [{ body: YEAR_2026 }] });
  const { data } = await run("check_date", { date: "2026-12-23" });
  assert.equal(data.cuti_bersama_known, true);
  assert.equal(data.is_working_day, true);
  assert.equal(data.note, undefined);
});

test("check_date: a later year is not known even when it lists cuti bersama", async () => {
  const withCuti = [...YEAR_2027, { name: "Cuti Bersama Tahun Baru", date: "2027-01-04", is_national_holiday: false }];
  const { run } = createRunner({ responses: [{ body: withCuti }] });
  const { data } = await run("check_date", { date: "2027-01-06" });
  assert.equal(data.cuti_bersama_known, false);
  assert.equal(data.is_working_day, null);
});

test("check_date refuses years outside 2011..2100 before any request", async () => {
  const { run, calls } = createRunner({ responses: [] });
  for (const date of ["2010-12-31", "2101-01-01", "0001-01-01"]) {
    await assert.rejects(run("check_date", { date }), (error) => error.kind === "invalid_input" && error.message.includes("2011"));
  }
  assert.equal(calls.length, 0);
});

test("count_working_days flags the result as uncertain for years without cuti bersama data", async () => {
  const { run } = createRunner({ responses: [{ body: YEAR_2026 }, { body: YEAR_2027 }] });
  const { data } = await run("count_working_days", { start_date: "2026-12-21", end_date: "2027-01-08" });
  assert.equal(data.uncertain, true);
  assert.deepEqual(data.uncertain_years, [2027]);
  assert.match(data.note, /2027/);
  const known = await run("count_working_days", { start_date: "2026-12-01", end_date: "2026-12-31" });
  assert.equal(known.data.uncertain, false);
  assert.equal(known.data.note, undefined);
});

for (const [label, nextYearBody] of [["empty", []], ["only invalid records", [{ name: "x" }, { date: "2027-01-01" }]], ["not a list", { holidays: [] }]]) {
  test(`next_holidays: a following year that is ${label} gives this year's holidays plus a coverage note`, async () => {
    const { run } = createRunner({ responses: [{ body: YEAR_2026 }, { body: nextYearBody }] });
    const { data } = await run("next_holidays", { from_date: "2026-12-01", count: 5 });
    assert.deepEqual(data.holidays.map((holiday) => holiday.date), ["2026-12-24", "2026-12-25"]);
    assert.match(data.coverage_note, /2027/);
  });

  test(`count_working_days: a following year that is ${label} makes the count uncertain instead of failing`, async () => {
    for (const cutiBersamaIsDayOff of [true, false]) {
      const { run } = createRunner({ responses: [{ body: YEAR_2026 }, { body: nextYearBody }] });
      const { data } = await run("count_working_days", { start_date: "2026-12-21", end_date: "2027-01-08", cuti_bersama_is_day_off: cutiBersamaIsDayOff });
      assert.equal(data.uncertain, true, `cuti_bersama_is_day_off ${cutiBersamaIsDayOff}`);
      assert.deepEqual(data.uncertain_years, [2027]);
      assert.match(data.note, /2027/);
    }
  });
}

test("count_working_days: an empty current year is still an api_error", async () => {
  const { run } = createRunner({ responses: [{ body: [] }] });
  await assert.rejects(run("count_working_days", { start_date: "2026-12-01", end_date: "2026-12-31" }), (error) => error.kind === "api_error");
});

test("sanitizeHolidayRecords drops items whose is_national_holiday is not a boolean", () => {
  const records = [
    { name: "Hari Raya Natal", date: "2026-12-25", is_national_holiday: true },
    { name: "Cuti Bersama", date: "2026-12-24", is_national_holiday: false },
    { name: "String flag", date: "2026-12-26", is_national_holiday: "true" },
    { name: "Missing flag", date: "2026-12-27" },
    { name: "Number flag", date: "2026-12-28", is_national_holiday: 1 },
  ];
  assert.deepEqual(sanitizeHolidayRecords(records, 2026).map((holiday) => holiday.name), ["Hari Raya Natal", "Cuti Bersama"]);
});

test("count_working_days without cuti bersama as days off is not uncertain", async () => {
  const { run } = createRunner({ responses: [{ body: YEAR_2027 }] });
  const { data } = await run("count_working_days", { start_date: "2027-01-01", end_date: "2027-01-31", cuti_bersama_is_day_off: false });
  assert.equal(data.uncertain, false);
});

test("a list with no valid records is an api_error and is not cached", async () => {
  const { run, calls } = createRunner({ responses: [{ body: [{ name: "x" }, { date: "nope" }] }, { body: YEAR_2026 }] });
  await assert.rejects(run("list_holidays", { year: 2026 }), (error) => error.kind === "api_error" && error.message.includes("2026"));
  const retried = await run("list_holidays", { year: 2026 });
  assert.equal(retried.data.length, 2);
  assert.equal(calls.length, 2);
});

test("invalid records are dropped from an otherwise good list", async () => {
  const { run } = createRunner({ responses: [{ body: [...YEAR_2026, { name: null, date: "2026-05-01" }, { name: "Bad", date: "01-05-2026" }] }] });
  const { data } = await run("list_holidays", { year: 2026 }, "node");
  assert.deepEqual(data.map((holiday) => holiday.date), ["2026-12-24", "2026-12-25"]);
});
