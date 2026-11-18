import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertValidTimeZone,
  formatInstantInTimeZone,
  parseInstant,
  readWallTime,
  wallTimeToInstantMs,
} from "../lib/time-zones.mjs";

const isInvalidInput = (error) => error.kind === "invalid_input";

test("assertValidTimeZone accepts IANA names and rejects junk and raw offsets", () => {
  for (const timeZone of ["Asia/Jakarta", "America/New_York", "Europe/Berlin", "UTC"]) assert.equal(assertValidTimeZone(timeZone), timeZone);
  for (const timeZone of ["Mars/Olympus", "+07:00", "-05:00", "", "  "]) assert.throws(() => assertValidTimeZone(timeZone), isInvalidInput, timeZone);
});

test("readWallTime gives local parts and the weekday (0 = Sunday)", () => {
  const instantMs = Date.parse("2026-11-18T02:30:00Z");
  assert.deepEqual(readWallTime(instantMs, "Asia/Jakarta"), { year: 2026, month: 11, day: 18, hour: 9, minute: 30, second: 0, weekday: 3 });
  assert.equal(readWallTime(Date.parse("2026-11-18T23:59:59Z"), "UTC").hour, 23);
  assert.equal(readWallTime(Date.parse("2026-11-19T00:00:00Z"), "UTC").hour, 0, "midnight is hour 0, not 24");
});

test("wallTimeToInstantMs converts plain local times", () => {
  assert.equal(wallTimeToInstantMs({ year: 2026, month: 11, day: 18, hour: 9, minute: 0 }, "Asia/Jakarta"), Date.parse("2026-11-18T02:00:00Z"));
  assert.equal(wallTimeToInstantMs({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }, "America/New_York"), Date.parse("2026-07-01T13:00:00Z"));
  assert.equal(wallTimeToInstantMs({ year: 2026, month: 12, day: 1, hour: 9, minute: 0 }, "America/New_York"), Date.parse("2026-12-01T14:00:00Z"));
});

test("wallTimeToInstantMs: a time skipped by spring-forward moves later by the gap", () => {
  // America/New_York 2026-03-08: 02:00 EST jumps to 03:00 EDT; 02:30 does not exist and becomes 03:30 EDT.
  assert.equal(wallTimeToInstantMs({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "America/New_York"), Date.parse("2026-03-08T07:30:00Z"));
  assert.equal(wallTimeToInstantMs({ year: 2026, month: 3, day: 8, hour: 3, minute: 0 }, "America/New_York"), Date.parse("2026-03-08T07:00:00Z"));
});

test("wallTimeToInstantMs with skippedTime gapEnd resolves a skipped time to the end of the gap", () => {
  const options = { skippedTime: "gapEnd" };
  assert.equal(wallTimeToInstantMs({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "America/New_York", options), Date.parse("2026-03-08T07:00:00Z"));
  assert.equal(wallTimeToInstantMs({ year: 2026, month: 3, day: 8, hour: 2, minute: 0 }, "America/New_York", options), Date.parse("2026-03-08T07:00:00Z"));
  assert.equal(wallTimeToInstantMs({ year: 2026, month: 3, day: 8, hour: 1, minute: 59 }, "America/New_York", options), Date.parse("2026-03-08T06:59:00Z"));
  // Australia/Lord_Howe skips only 30 minutes: 02:00 +10:30 jumps to 02:30 +11:00 on 2026-10-04.
  assert.equal(wallTimeToInstantMs({ year: 2026, month: 10, day: 4, hour: 2, minute: 15 }, "Australia/Lord_Howe", options), Date.parse("2026-10-03T15:30:00Z"));
  // Pacific/Apia skipped all of 2011-12-30.
  assert.equal(wallTimeToInstantMs({ year: 2011, month: 12, day: 30, hour: 12, minute: 0 }, "Pacific/Apia", options), Date.parse("2011-12-30T10:00:00Z"));
});

test("wallTimeToInstantMs: a repeated time after fall-back picks the earlier occurrence", () => {
  // America/New_York 2026-11-01: 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST).
  assert.equal(wallTimeToInstantMs({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, "America/New_York"), Date.parse("2026-11-01T05:30:00Z"));
});

test("formatInstantInTimeZone writes RFC 3339 with the zone's offset at that instant", () => {
  assert.equal(formatInstantInTimeZone(Date.parse("2026-11-18T02:00:00Z"), "Asia/Jakarta"), "2026-11-18T09:00:00+07:00");
  assert.equal(formatInstantInTimeZone(Date.parse("2026-11-01T05:30:00Z"), "America/New_York"), "2026-11-01T01:30:00-04:00");
  assert.equal(formatInstantInTimeZone(Date.parse("2026-11-01T06:30:00Z"), "America/New_York"), "2026-11-01T01:30:00-05:00");
  assert.equal(formatInstantInTimeZone(Date.parse("2026-11-18T02:00:00Z"), "UTC"), "2026-11-18T02:00:00Z");
  assert.equal(formatInstantInTimeZone(Date.parse("2026-11-18T02:00:00Z"), "Asia/Kolkata"), "2026-11-18T07:30:00+05:30");
});

test("parseInstant accepts offsets, and local or date-only values with a time zone", () => {
  assert.equal(parseInstant("2026-11-18T09:00:00+07:00", { name: "t" }), Date.parse("2026-11-18T02:00:00Z"));
  assert.equal(parseInstant("2026-11-18T02:00:00.123Z", { name: "t" }), Date.parse("2026-11-18T02:00:00.123Z"));
  assert.equal(parseInstant("2026-11-18t02:00:00z", { name: "t" }), Date.parse("2026-11-18T02:00:00Z"));
  assert.equal(parseInstant("2026-11-18T09:00", { name: "t", timeZone: "Asia/Jakarta" }), Date.parse("2026-11-18T02:00:00Z"));
  assert.equal(parseInstant("2026-11-18", { name: "t", timeZone: "Asia/Jakarta" }), Date.parse("2026-11-17T17:00:00Z"));
});

test("parseInstant rejects malformed values and local values without a time zone", () => {
  const badValues = ["tomorrow", "2026-13-01T00:00:00Z", "2026-02-30", "2026-11-18T25:00:00Z", "2026-11-18T09:00:00+7", "1700000000"];
  for (const badValue of badValues) assert.throws(() => parseInstant(badValue, { name: "time_min", timeZone: "UTC" }), isInvalidInput, badValue);
  assert.throws(() => parseInstant("2026-11-18T09:00", { name: "time_min" }), (error) => isInvalidInput(error) && /time_min/.test(error.message) && /time_zone/.test(error.message));
});
