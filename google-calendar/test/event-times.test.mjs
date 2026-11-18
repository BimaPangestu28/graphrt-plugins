import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEventTimes } from "../lib/event-resource.mjs";
import { parseInstant } from "../lib/time-zones.mjs";
import { isInvalidInput, runWithResponses } from "./helpers.mjs";

test("update_event turning an all-day event into a timed one clears `date` on both edges", async () => {
  const args = { event_id: "e1", start: "2026-11-20T09:00:00+07:00", end: "2026-11-20T10:00:00+07:00" };
  const { calls } = await runWithResponses("update_event", args, [{ body: { id: "e1" } }]);
  assert.deepEqual(calls[0].json.start, { dateTime: "2026-11-20T09:00:00+07:00", date: null });
  assert.deepEqual(calls[0].json.end, { dateTime: "2026-11-20T10:00:00+07:00", date: null });
});

test("update_event turning a timed event into an all-day one clears `dateTime` and `timeZone`", async () => {
  const { calls } = await runWithResponses("update_event", { event_id: "e1", start: "2026-11-20", end: "2026-11-21" }, [{ body: { id: "e1" } }]);
  assert.deepEqual(calls[0].json.start, { date: "2026-11-20", dateTime: null, timeZone: null });
  assert.deepEqual(calls[0].json.end, { date: "2026-11-21", dateTime: null, timeZone: null });
});

test("update_event with a time zone keeps it next to the timed edge", async () => {
  const args = { event_id: "e1", start: "2026-11-20T09:00", end: "2026-11-20T10:00", time_zone: "Asia/Jakarta" };
  const { calls } = await runWithResponses("update_event", args, [{ body: { id: "e1" } }]);
  assert.deepEqual(calls[0].json.start, { dateTime: "2026-11-20T09:00:00", timeZone: "Asia/Jakarta", date: null });
});

test("create_event bodies never carry the null clearing fields", async () => {
  const timed = await runWithResponses("create_event", { start: "2026-11-20T09:00:00Z", end: "2026-11-20T10:00:00Z" }, [{ body: { id: "x" } }]);
  assert.deepEqual(timed.calls[0].json.start, { dateTime: "2026-11-20T09:00:00Z" });
  const allDay = await runWithResponses("create_event", { start: "2026-11-20" }, [{ body: { id: "x" } }]);
  assert.deepEqual(allDay.calls[0].json.start, { date: "2026-11-20" });
});

test("event date-times are sent as YYYY-MM-DDTHH:MM:SS plus the given offset in upper case", () => {
  const normalizedCases = [
    ["2026-11-20T09:00", "Asia/Jakarta", "2026-11-20T09:00:00"],
    ["2026-11-20T09:00:00", "Asia/Jakarta", "2026-11-20T09:00:00"],
    ["2026-11-20t09:00z", undefined, "2026-11-20T09:00:00Z"],
    ["2026-11-20T09:00:00.999999+07:00", undefined, "2026-11-20T09:00:00+07:00"],
    ["2026-11-20T09:00:30.5-03:30", undefined, "2026-11-20T09:00:30-03:30"],
    ["  2026-11-20T09:00+14:00 ", undefined, "2026-11-20T09:00:00+14:00"],
    ["2026-11-20T09:00-12:00", undefined, "2026-11-20T09:00:00-12:00"],
  ];
  for (const [input, timeZone, expected] of normalizedCases) {
    const times = buildEventTimes({ start: input, end: "2026-11-21T09:00:00Z", time_zone: timeZone });
    assert.equal(times.start.dateTime, expected, input);
  }
});

test("offsets beyond +-14:00 or with minutes over 59 are invalid_input", () => {
  for (const badOffset of ["+14:30", "+15:00", "-14:01", "+99:00", "+05:60", "-00:75"]) {
    const value = `2026-11-20T09:00:00${badOffset}`;
    assert.throws(() => buildEventTimes({ start: value, end: "2026-11-22T09:00:00Z" }), isInvalidInput, value);
    assert.throws(() => parseInstant(value, { name: "time_min" }), isInvalidInput, value);
  }
});

test("end must be after start once fractions are truncated", () => {
  assert.throws(
    () => buildEventTimes({ start: "2026-11-20T09:00:00.100Z", end: "2026-11-20T09:00:00.900Z" }),
    (error) => isInvalidInput(error) && /after/.test(error.message),
  );
});
