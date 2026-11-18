import { test } from "node:test";
import assert from "node:assert/strict";
import { CALENDAR_BASE_PATH, isInvalidInput, runCapturingFailure, runWithResponses } from "./helpers.mjs";

const SEARCH_ARGS = { time_min: "2026-11-18", time_max: "2026-11-19", duration_minutes: 60, slot_step_minutes: 60, time_zone: "Asia/Jakarta" };

test("find_free_slots queries free/busy for the range and computes slots from the busy time", async () => {
  const freeBusy = {
    calendars: {
      primary: { busy: [{ start: "2026-11-18T03:00:00Z", end: "2026-11-18T05:00:00Z" }] },
      "bob@example.com": { busy: [{ start: "2026-11-18T07:00:00Z", end: "2026-11-18T08:00:00Z" }] },
    },
  };
  const { output, calls } = await runWithResponses("find_free_slots", { ...SEARCH_ARGS, calendar_ids: ["primary", "bob@example.com"] }, [{ body: freeBusy }]);
  assert.equal(calls.length, 1);
  assert.equal(decodeURIComponent(calls[0].path), `${CALENDAR_BASE_PATH}/freeBusy`);
  assert.deepEqual(calls[0].json, { timeMin: "2026-11-17T17:00:00.000Z", timeMax: "2026-11-18T17:00:00.000Z", items: [{ id: "primary" }, { id: "bob@example.com" }] });
  assert.deepEqual(
    output.data.slots.map((slot) => slot.start.slice(11, 16)),
    ["09:00", "12:00", "13:00", "15:00", "16:00"],
  );
  assert.equal(output.data.time_zone, "Asia/Jakarta");
  assert.equal(output.data.busy_interval_count, 2);
  assert.equal(output.data.truncated, false);
});

test("find_free_slots widens the free/busy query by the buffer", async () => {
  const { calls } = await runWithResponses("find_free_slots", { ...SEARCH_ARGS, buffer_minutes: 15 }, [{ body: { calendars: { primary: { busy: [] } } } }]);
  assert.equal(calls[0].json.timeMin, "2026-11-17T16:45:00.000Z");
  assert.equal(calls[0].json.timeMax, "2026-11-18T17:15:00.000Z");
});

test("find_free_slots merges extra_busy, including all-day dates", async () => {
  const { output } = await runWithResponses(
    "find_free_slots",
    { ...SEARCH_ARGS, time_max: "2026-11-20", duration_minutes: 480, extra_busy: [{ start: "2026-11-18", end: "2026-11-19" }] },
    [{ body: { calendars: { primary: { busy: [] } } } }],
  );
  assert.deepEqual(output.data.slots, [{ start: "2026-11-19T09:00:00+07:00", end: "2026-11-19T17:00:00+07:00" }]);
});

test("find_free_slots without time_zone uses the account's Calendar time zone setting", async () => {
  const { time_zone: omitted, ...argsWithoutZone } = SEARCH_ARGS;
  assert.ok(omitted);
  const { output, calls } = await runWithResponses("find_free_slots", argsWithoutZone, [{ body: { value: "America/New_York" } }, { body: { calendars: { primary: { busy: [] } } } }]);
  assert.equal(decodeURIComponent(calls[0].path), `${CALENDAR_BASE_PATH}/users/me/settings/timezone`);
  assert.equal(output.data.time_zone, "America/New_York");
  assert.equal(output.data.slots[0].start, "2026-11-18T09:00:00-05:00");
});

test("find_free_slots fails instead of guessing when a calendar's free/busy is unavailable", async () => {
  const freeBusy = { calendars: { primary: { busy: [] }, "bob@example.com": { busy: [], errors: [{ domain: "global", reason: "notFound" }] } } };
  await assert.rejects(
    runWithResponses("find_free_slots", { ...SEARCH_ARGS, calendar_ids: ["primary", "bob@example.com"] }, [{ body: freeBusy }]),
    (error) => error.kind === "not_found" && /bob@example.com: notFound/.test(error.message),
  );
  await assert.rejects(
    runWithResponses("find_free_slots", SEARCH_ARGS, [{ body: { calendars: { primary: { errors: [{ reason: "internalError" }] } } } }]),
    (error) => error.kind === "api_error",
  );
});

test("find_free_slots validates its inputs before calling Google", async () => {
  for (const overrides of [{ working_hours: { wed: ["9-5"] } }, { time_max: "2027-06-01" }, { extra_busy: [{ start: "x", end: "y" }] }, { time_zone: "Nowhere" }]) {
    const { error, calls } = await runCapturingFailure("find_free_slots", { ...SEARCH_ARGS, ...overrides });
    assert.ok(error && isInvalidInput(error), `${JSON.stringify(overrides)}: ${error?.message}`);
    assert.equal(calls.length, 0, JSON.stringify(overrides));
  }
});
