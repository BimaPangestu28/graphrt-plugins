import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveEventId } from "../lib/event-ids.mjs";
import { pluginDefinition } from "../definition.mjs";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { CALENDAR_BASE_PATH, TEST_ENVIRONMENT, isInvalidInput, runCapturingFailure, runWithResponses } from "./helpers.mjs";

const TEAM_CALENDAR = "team@group.calendar.google.com";
const BOOKING_EVENT_ID = deriveEventId("booking-42");

// Each case: operation + args (as a workflow node) -> expected first request: method, decoded path, query subset, json subset.
const REQUEST_CASES = [
  ["list_calendars", {}, { method: "GET", path: "/users/me/calendarList", query: { maxResults: "100" } }],
  [
    "list_calendars",
    { min_access_role: "writer", show_hidden: true, limit: 10, cursor: "page-2" },
    { method: "GET", path: "/users/me/calendarList", query: { minAccessRole: "writer", showHidden: "true", maxResults: "10", pageToken: "page-2" } },
  ],
  [
    "query_free_busy",
    { calendar_ids: ["primary", "bob@example.com"], time_min: "2026-11-20", time_max: "2026-11-21", time_zone: "Asia/Jakarta" },
    {
      method: "POST",
      path: "/freeBusy",
      json: {
        timeMin: "2026-11-19T17:00:00.000Z",
        timeMax: "2026-11-20T17:00:00.000Z",
        timeZone: "Asia/Jakarta",
        items: [{ id: "primary" }, { id: "bob@example.com" }],
      },
    },
  ],
  [
    "list_events",
    {},
    { method: "GET", path: "/calendars/primary/events", query: { singleEvents: "true", orderBy: "startTime", maxResults: "50" } },
  ],
  [
    "list_events",
    { calendar_id: TEAM_CALENDAR, time_min: "2026-11-20T00:00:00+07:00", time_max: "2026-11-21T00:00:00+07:00", q: "standup", limit: 5, cursor: "c2" },
    {
      method: "GET",
      path: `/calendars/${TEAM_CALENDAR}/events`,
      query: { timeMin: "2026-11-19T17:00:00.000Z", timeMax: "2026-11-20T17:00:00.000Z", q: "standup", maxResults: "5", pageToken: "c2" },
    },
  ],
  ["list_events", { single_events: false, order_by: "updated" }, { method: "GET", path: "/calendars/primary/events", query: { singleEvents: "false", orderBy: "updated" } }],
  ["get_event", { calendar_id: TEAM_CALENDAR, event_id: "abc123", time_zone: "Asia/Jakarta" }, { method: "GET", path: `/calendars/${TEAM_CALENDAR}/events/abc123`, query: { timeZone: "Asia/Jakarta" } }],
  [
    "create_event",
    {
      summary: "Demo",
      description: "Product demo",
      location: "Jakarta",
      start: "2026-11-20T09:00:00",
      end: "2026-11-20T10:00:00",
      time_zone: "Asia/Jakarta",
      attendees: ["sari@example.com", { email: "budi@example.com", optional: true, display_name: "Budi" }],
      reminders: [{ method: "email", minutes: 60 }, { minutes: 10 }],
      add_google_meet: true,
      idempotency_key: "booking-42",
      private_properties: { booking_id: 42 },
      send_updates: "all",
    },
    {
      method: "POST",
      path: "/calendars/primary/events",
      query: { sendUpdates: "all", conferenceDataVersion: "1" },
      json: {
        id: BOOKING_EVENT_ID,
        summary: "Demo",
        description: "Product demo",
        location: "Jakarta",
        start: { dateTime: "2026-11-20T09:00:00", timeZone: "Asia/Jakarta" },
        end: { dateTime: "2026-11-20T10:00:00", timeZone: "Asia/Jakarta" },
        attendees: [{ email: "sari@example.com" }, { email: "budi@example.com", optional: true, displayName: "Budi" }],
        reminders: { useDefault: false, overrides: [{ method: "email", minutes: 60 }, { method: "popup", minutes: 10 }] },
        extendedProperties: { private: { booking_id: "42", graphrt_created: "1" } },
        conferenceData: { createRequest: { requestId: BOOKING_EVENT_ID, conferenceSolutionKey: { type: "hangoutsMeet" } } },
      },
    },
  ],
  [
    "create_event",
    { summary: "Holiday", start: "2026-11-20", use_default_reminders: false, transparency: "transparent" },
    {
      method: "POST",
      path: "/calendars/primary/events",
      query: { sendUpdates: "none" },
      json: { summary: "Holiday", start: { date: "2026-11-20" }, end: { date: "2026-11-21" }, reminders: { useDefault: false }, transparency: "transparent" },
    },
  ],
  [
    "create_event",
    { summary: "Weekly", start: "2026-11-20T09:00:00", end: "2026-11-20T09:30:00", time_zone: "Asia/Jakarta", recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"], event_id: "abcde12345" },
    { method: "POST", path: "/calendars/primary/events", json: { id: "abcde12345", recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"] } },
  ],
  [
    "update_event",
    { event_id: "evt1", summary: "Moved", start: "2026-11-21T09:00:00+07:00", end: "2026-11-21T10:00:00+07:00" },
    {
      method: "PATCH",
      path: "/calendars/primary/events/evt1",
      query: { sendUpdates: "none" },
      json: { summary: "Moved", start: { dateTime: "2026-11-21T09:00:00+07:00" }, end: { dateTime: "2026-11-21T10:00:00+07:00" } },
    },
  ],
  ["delete_event", { event_id: "evt1", send_updates: "all" }, { method: "DELETE", path: "/calendars/primary/events/evt1", query: { sendUpdates: "all" } }],
  ["quick_add", { text: "Lunch with Sari tomorrow 12:30" }, { method: "POST", path: "/calendars/primary/events/quickAdd", query: { text: "Lunch with Sari tomorrow 12:30", sendUpdates: "none" } }],
  ["api_request", { path: "/colors" }, { method: "GET", path: "/colors" }],
  ["api_request", { method: "POST", path: "/calendars", body: { summary: "New" } }, { method: "POST", path: "/calendars", json: { summary: "New" } }],
];

for (const [operationName, args, expectedRequest] of REQUEST_CASES) {
  test(`${operationName} ${JSON.stringify(args).slice(0, 80)} sends ${expectedRequest.method} ${expectedRequest.path}`, async () => {
    const { calls } = await runWithResponses(operationName, args, [{ body: { id: "evt1" } }, { body: { id: "evt1" } }]);
    const [call] = calls;
    assert.equal(call.method, expectedRequest.method);
    assert.equal(decodeURIComponent(call.path), CALENDAR_BASE_PATH + expectedRequest.path);
    assert.equal(call.headers.authorization, "Bearer google-token");
    for (const [queryName, expectedValue] of Object.entries(expectedRequest.query ?? {})) assert.equal(call.query[queryName], expectedValue, `query.${queryName}`);
    if (expectedRequest.json) assertContains(call.json, expectedRequest.json);
  });
}

function assertContains(actual, expected, label = "json") {
  if (expected === null || typeof expected !== "object") return assert.deepEqual(actual, expected, label);
  if (Array.isArray(expected)) return assert.deepEqual(actual, expected, label);
  for (const [fieldName, expectedValue] of Object.entries(expected)) assertContains(actual?.[fieldName], expectedValue, `${label}.${fieldName}`);
}

test("a create without idempotency_key sends a fresh random base32hex id each time", async () => {
  const args = { start: "2026-11-20T09:00:00Z", end: "2026-11-20T10:00:00Z" };
  const first = await runWithResponses("create_event", args, [{ body: { id: "x" } }]);
  const second = await runWithResponses("create_event", args, [{ body: { id: "y" } }]);
  assert.match(first.calls[0].json.id, /^[a-v0-9]{32}$/);
  assert.notEqual(first.calls[0].json.id, second.calls[0].json.id);
  assert.equal(first.calls[0].query.conferenceDataVersion, undefined);
});

test("list_events filters on private properties with repeated privateExtendedProperty parameters", async () => {
  const { calls } = await runWithResponses("list_events", { private_properties: { booking_id: "42" }, created_by_plugin: true }, [{ body: {} }]);
  const filters = new URL(calls[0].url).searchParams.getAll("privateExtendedProperty");
  assert.deepEqual(filters, ["booking_id=42", "graphrt_created=1"]);
});

test("list_events rejects private_properties filter values that are not strings, numbers or booleans", async () => {
  for (const badValue of [{ nested: "x" }, ["a"], null]) {
    const { error, calls } = await runCapturingFailure("list_events", { private_properties: { booking_id: badValue } });
    assert.ok(error && isInvalidInput(error), JSON.stringify(badValue));
    assert.match(error.message, /private_properties\.booking_id/);
    assert.equal(calls.length, 0);
  }
  const { calls } = await runWithResponses("list_events", { private_properties: { booking_id: 42, paid: true } }, [{ body: {} }]);
  assert.deepEqual(new URL(calls[0].url).searchParams.getAll("privateExtendedProperty"), ["booking_id=42", "paid=true"]);
});

test("list_events maps events and paging", async () => {
  const eventList = {
    timeZone: "Asia/Jakarta",
    nextPageToken: "next-1",
    items: [
      {
        id: "e1",
        status: "confirmed",
        summary: "Demo",
        start: { dateTime: "2026-11-20T09:00:00+07:00", timeZone: "Asia/Jakarta" },
        end: { dateTime: "2026-11-20T10:00:00+07:00" },
        htmlLink: "https://www.google.com/calendar/event?eid=1",
        conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }], createRequest: { status: { statusCode: "success" } } },
        attendees: [{ email: "sari@example.com", responseStatus: "accepted" }],
        extendedProperties: { private: { graphrt_created: "1" } },
      },
      { id: "e2", start: { date: "2026-11-21" }, end: { date: "2026-11-22" } },
    ],
  };
  const { output } = await runWithResponses("list_events", {}, [{ body: eventList }]);
  assert.equal(output.next_cursor, "next-1");
  assert.equal(output.data.time_zone, "Asia/Jakarta");
  const [timedEvent, allDayEvent] = output.data.events;
  assert.equal(timedEvent.meet_link, "https://meet.google.com/abc-defg-hij");
  assert.equal(timedEvent.conference_status, "success");
  assert.equal(timedEvent.created_by_plugin, true);
  assert.deepEqual(timedEvent.attendees[0], { email: "sari@example.com", display_name: null, response_status: "accepted", optional: false, organizer: false, self: false });
  assert.equal(allDayEvent.all_day, true);
  assert.equal(allDayEvent.start, "2026-11-21");
  assert.equal(allDayEvent.created_by_plugin, false);
  const lastPage = await runWithResponses("list_events", {}, [{ body: { items: [] } }]);
  assert.equal(lastPage.output.next_cursor, null);
});

test("list_calendars maps entries and pages", async () => {
  const calendarList = {
    nextPageToken: "p2",
    items: [{ id: "me@example.com", summary: "Me", primary: true, timeZone: "Asia/Jakarta", accessRole: "owner" }],
  };
  const { output } = await runWithResponses("list_calendars", {}, [{ body: calendarList }]);
  assert.equal(output.next_cursor, "p2");
  assert.deepEqual(output.data.calendars[0], {
    calendar_id: "me@example.com",
    summary: "Me",
    description: null,
    time_zone: "Asia/Jakarta",
    access_role: "owner",
    primary: true,
    hidden: false,
    agent_tool_allowed: true,
  });
});

test("query_free_busy returns busy intervals and per-calendar errors as data", async () => {
  const freeBusy = {
    timeMin: "2026-11-20T00:00:00.000Z",
    timeMax: "2026-11-21T00:00:00.000Z",
    calendars: {
      primary: { busy: [{ start: "2026-11-20T02:00:00Z", end: "2026-11-20T03:00:00Z" }] },
      "bob@example.com": { errors: [{ domain: "global", reason: "notFound" }], busy: [] },
    },
  };
  const { output, calls } = await runWithResponses("query_free_busy", { calendar_ids: ["primary", "bob@example.com"], time_min: "2026-11-20T00:00:00Z", time_max: "2026-11-21T00:00:00Z" }, [{ body: freeBusy }]);
  assert.equal(calls[0].json.timeZone, undefined);
  assert.deepEqual(output.data.calendars, [
    { calendar_id: "primary", busy: [{ start: "2026-11-20T02:00:00Z", end: "2026-11-20T03:00:00Z" }], errors: [] },
    { calendar_id: "bob@example.com", busy: [], errors: [{ domain: "global", reason: "notFound" }] },
  ]);
});

test("free/busy is a read: server errors are retried although it is a POST", async () => {
  const { calls } = await runWithResponses(
    "query_free_busy",
    { time_min: "2026-11-20T00:00:00Z", time_max: "2026-11-21T00:00:00Z" },
    [{ status: 503, headers: { "retry-after": "0" }, body: { error: { code: 503, message: "Backend Error", errors: [{ reason: "backendError" }] } } }, { body: { calendars: {} } }],
  );
  assert.equal(calls.length, 2);
});

test("operation input validation is invalid_input before any request", async () => {
  const invalidCalls = [
    ["create_event", { start: "2026-11-20T10:00:00Z", end: "2026-11-20T09:00:00Z" }, /after/],
    ["create_event", { start: "2026-11-20T10:00:00Z" }, /end/],
    ["create_event", { start: "2026-11-20", end: "2026-11-20T10:00:00Z" }, /dates for both/],
    ["create_event", { start: "2026-11-20", end: "2026-11-20" }, /exclusive/],
    ["create_event", { start: "2026-11-20T09:00", end: "2026-11-20T10:00" }, /time_zone/],
    ["create_event", { start: "2026-11-20T09:00Z", end: "2026-11-20T10:00Z", time_zone: "Jakarta" }, /time zone/],
    ["create_event", { start: "2026-11-20T09:00Z", end: "2026-11-20T10:00Z", event_id: "UPPER_case" }, /base32hex/],
    ["create_event", { start: "2026-11-20T09:00Z", end: "2026-11-20T10:00Z", event_id: "abcde", idempotency_key: "k" }, /not both/],
    ["create_event", { start: "2026-11-20T09:00Z", end: "2026-11-20T10:00Z", reminders: Array.from({ length: 6 }, () => ({ minutes: 5 })) }, /At most 5/],
    ["create_event", { start: "2026-11-20T09:00Z", end: "2026-11-20T10:00Z", reminders: [{ method: "sms", minutes: 5 }] }, /popup or email/],
    ["create_event", { start: "2026-11-20T09:00Z", end: "2026-11-20T10:00Z", reminders: [{ minutes: 50000 }] }, /40320/],
    ["create_event", { start: "2026-11-20T09:00Z", end: "2026-11-20T10:00Z", attendees: ["not-an-email"] }, /attendees\[0\]/],
    ["create_event", { start: "2026-11-20T09:00Z", end: "2026-11-20T10:00Z", recurrence: ["FREQ=DAILY"] }, /RRULE/],
    ["create_event", { start: "2026-11-20T09:00Z", end: "2026-11-20T10:00Z", recurrence: ["RRULE:FREQ=DAILY"] }, /time_zone/],
    ["create_event", { start: "2026-11-20T09:00Z", end: "2026-11-20T10:00Z", private_properties: { nested: { a: 1 } } }, /private_properties.nested/],
    ["create_event", { start: "2026-11-20", book_slot: true }, /book_slot/],
    ["update_event", { event_id: "e1" }, /Nothing to update/],
    ["update_event", { event_id: "e1", time_zone: "Asia/Jakarta" }, /time_zone/],
    ["list_events", { single_events: false, order_by: "startTime" }, /single_events/],
    ["list_events", { time_min: "next week" }, /time_min/],
    ["query_free_busy", { time_min: "2026-11-21T00:00:00Z", time_max: "2026-11-20T00:00:00Z" }, /after/],
    ["query_free_busy", { calendar_ids: [], time_min: "2026-11-20T00:00:00Z", time_max: "2026-11-21T00:00:00Z" }, /at least one/],
    ["get_event", { event_id: ".." }, /Invalid id/],
  ];
  for (const [operationName, args, expectedMessage] of invalidCalls) {
    const recordingFetch = createRecordingFetch([]);
    const runOperation = createOperationRunner(pluginDefinition, TEST_ENVIRONMENT, { fetchImpl: recordingFetch });
    await assert.rejects(
      runOperation(operationName, args, { source: "node" }),
      (error) => isInvalidInput(error) && expectedMessage.test(error.message),
      `${operationName} ${JSON.stringify(args)}`,
    );
    assert.equal(recordingFetch.calls.length, 0, `${operationName} ${JSON.stringify(args)} must not send a request`);
  }
});
