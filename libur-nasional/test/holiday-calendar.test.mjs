import { test } from "node:test";
import assert from "node:assert/strict";
import { countWorkingDays, describeDate, jakartaToday, normalizeHoliday, parseIsoDate, pickUpcoming } from "../lib/holiday-calendar.mjs";

const HOLIDAYS_2026 = [
  { name: "Cuti Bersama Hari Raya Idul Fitri 1447 Hijriyah", date: "2026-03-20", is_national_holiday: false },
  { name: "Hari Raya Idul Fitri 1447 Hijriyah", date: "2026-03-21", is_national_holiday: true },
  { name: "Hari Raya Idul Fitri 1447 Hijriyah", date: "2026-03-22", is_national_holiday: true },
  { name: "Cuti Bersama Hari Raya Idul Fitri 1447 Hijriyah", date: "2026-03-23", is_national_holiday: false },
  { name: "Cuti Bersama Hari Raya Idul Fitri 1447 Hijriyah", date: "2026-03-24", is_national_holiday: false },
  { name: "Wafat Yesus Kristus / Jumat Agung", date: "2026-04-03", is_national_holiday: true },
].map(normalizeHoliday);

test("normalizeHoliday adds the kind: libur_nasional or cuti_bersama", () => {
  assert.equal(HOLIDAYS_2026[0].kind, "cuti_bersama");
  assert.equal(HOLIDAYS_2026[1].kind, "libur_nasional");
  assert.equal(HOLIDAYS_2026[1].name, "Hari Raya Idul Fitri 1447 Hijriyah");
});

test("parseIsoDate accepts real YYYY-MM-DD dates only", () => {
  assert.deepEqual(parseIsoDate("2026-03-21", "date"), { year: 2026, month: 3, day: 21, text: "2026-03-21" });
  for (const badDate of ["2026-02-30", "2026-3-1", "21-03-2026", "2026-13-01", "", "2026-03-21T00:00"]) {
    assert.throws(() => parseIsoDate(badDate, "date"), (error) => error.kind === "invalid_input" && error.message.includes("`date`"));
  }
});

test("jakartaToday is the UTC+7 calendar date", () => {
  assert.equal(jakartaToday(Date.parse("2026-11-19T16:59:59Z")), "2026-11-19");
  assert.equal(jakartaToday(Date.parse("2026-11-19T17:00:00Z")), "2026-11-20");
});

test("describeDate reports holidays, cuti bersama and weekends", () => {
  assert.deepEqual(describeDate("2026-03-21", HOLIDAYS_2026), {
    date: "2026-03-21",
    day_of_week: "Saturday",
    hari: "Sabtu",
    is_weekend: true,
    is_holiday: true,
    is_national_holiday: true,
    is_cuti_bersama: false,
    is_working_day: false,
    cuti_bersama_known: true,
    holidays: ["Hari Raya Idul Fitri 1447 Hijriyah"],
  });
  const cutiBersama = describeDate("2026-03-23", HOLIDAYS_2026);
  assert.equal(cutiBersama.is_cuti_bersama, true);
  assert.equal(cutiBersama.is_national_holiday, false);
  assert.equal(cutiBersama.is_working_day, false);
  const ordinaryDay = describeDate("2026-03-25", HOLIDAYS_2026);
  assert.equal(ordinaryDay.hari, "Rabu");
  assert.equal(ordinaryDay.is_holiday, false);
  assert.equal(ordinaryDay.is_working_day, true);
  assert.deepEqual(ordinaryDay.holidays, []);
});

test("countWorkingDays excludes weekends and holidays, with cuti bersama optional", () => {
  const withCuti = countWorkingDays("2026-03-16", "2026-03-27", HOLIDAYS_2026, { cutiBersamaIsDayOff: true });
  assert.equal(withCuti.calendar_days, 12);
  assert.equal(withCuti.weekend_days, 2);
  assert.equal(withCuti.working_days, 7);
  assert.deepEqual(withCuti.days_off_on_weekdays.map((day) => day.date), ["2026-03-20", "2026-03-23", "2026-03-24"]);
  const withoutCuti = countWorkingDays("2026-03-16", "2026-03-27", HOLIDAYS_2026, { cutiBersamaIsDayOff: false });
  assert.equal(withoutCuti.working_days, 10);
  assert.deepEqual(withoutCuti.days_off_on_weekdays, []);
});

test("pickUpcoming returns holidays on or after a date, optionally without cuti bersama", () => {
  assert.deepEqual(pickUpcoming(HOLIDAYS_2026, "2026-03-22", { count: 2, includeCutiBersama: true }).map((holiday) => holiday.date), ["2026-03-22", "2026-03-23"]);
  assert.deepEqual(pickUpcoming(HOLIDAYS_2026, "2026-03-22", { count: 2, includeCutiBersama: false }).map((holiday) => holiday.date), ["2026-03-22", "2026-04-03"]);
});
