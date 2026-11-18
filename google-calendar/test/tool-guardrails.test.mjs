import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { TEST_ENVIRONMENT, isPermissionDenied, runAsTool, runCapturingFailure, runWithResponses } from "./helpers.mjs";

const OTHER_CALENDAR = "boss@example.com";
const TIMED_ARGS = { start: "2026-11-20T09:00:00Z", end: "2026-11-20T10:00:00Z" };
const TAGGED_EVENT = { id: "e1", status: "confirmed", extendedProperties: { private: { graphrt_created: "1" } } };
const FOREIGN_EVENT = { id: "e1", status: "confirmed", extendedProperties: { private: { owner: "someone" } } };
const RANGE = { time_min: "2026-11-20T00:00:00Z", time_max: "2026-11-21T00:00:00Z" };

const CALENDAR_SCOPED_CALLS = [
  ["list_events", { calendar_id: OTHER_CALENDAR }],
  ["get_event", { calendar_id: OTHER_CALENDAR, event_id: "e1" }],
  ["create_event", { calendar_id: OTHER_CALENDAR, ...TIMED_ARGS }],
  ["update_event", { calendar_id: OTHER_CALENDAR, event_id: "e1", summary: "x" }],
  ["delete_event", { calendar_id: OTHER_CALENDAR, event_id: "e1" }],
  ["quick_add", { calendar_id: OTHER_CALENDAR, text: "Lunch" }],
  ["query_free_busy", { calendar_ids: ["primary", OTHER_CALENDAR], ...RANGE }],
  ["find_free_slots", { calendar_ids: [OTHER_CALENDAR], ...RANGE, duration_minutes: 30, time_zone: "UTC" }],
  ["api_request", { path: `/calendars/${encodeURIComponent(OTHER_CALENDAR)}/events` }],
  ["api_request", { path: `/users/me/calendarList/${OTHER_CALENDAR}` }],
];

for (const [operationName, args] of CALENDAR_SCOPED_CALLS) {
  test(`tool ${operationName} on a calendar outside the allowlist is permission_denied before any request`, async () => {
    const { error, calls } = await runCapturingFailure(operationName, args, [], TEST_ENVIRONMENT, "tool");
    assert.ok(error && isPermissionDenied(error), error?.message);
    assert.match(error.message, /GOOGLE_CALENDAR_TOOL_ALLOWED_IDS/);
    assert.equal(calls.length, 0);
  });

  test(`node ${operationName} on any calendar is allowed`, async () => {
    const { error, calls } = await runCapturingFailure(operationName, args, [{ body: { ...FOREIGN_EVENT, calendars: { [OTHER_CALENDAR]: { busy: [] } } } }, { body: FOREIGN_EVENT }]);
    assert.equal(error, null, error?.message);
    assert.ok(calls.length >= 1);
  });
}

test("the allowlist is comma-separated, case-insensitive, and * allows every calendar", async () => {
  const environment = { ...TEST_ENVIRONMENT, GOOGLE_CALENDAR_TOOL_ALLOWED_IDS: " primary , Boss@Example.com " };
  await runAsTool("list_events", { calendar_id: OTHER_CALENDAR }, [{ body: {} }], environment);
  await assert.rejects(runAsTool("list_events", {}, [{ body: {} }], { ...environment, GOOGLE_CALENDAR_TOOL_ALLOWED_IDS: OTHER_CALENDAR }), isPermissionDenied);
  await runAsTool("list_events", { calendar_id: "anything@example.com" }, [{ body: {} }], { ...TEST_ENVIRONMENT, GOOGLE_CALENDAR_TOOL_ALLOWED_IDS: "*" });
});

test("tool calls never email guests unless GOOGLE_CALENDAR_TOOL_SEND_UPDATES=1", async () => {
  const args = { ...TIMED_ARGS, attendees: ["guest@example.com"], send_updates: "all" };
  const suppressed = await runAsTool("create_event", args, [{ body: TAGGED_EVENT }]);
  assert.equal(suppressed.calls[0].query.sendUpdates, "none");
  assert.equal(suppressed.output.data.send_updates, "none");
  assert.match(suppressed.output.data.notifications_suppressed, /GOOGLE_CALENDAR_TOOL_SEND_UPDATES=1/);
  const allowed = await runAsTool("create_event", args, [{ body: TAGGED_EVENT }], { ...TEST_ENVIRONMENT, GOOGLE_CALENDAR_TOOL_SEND_UPDATES: "1" });
  assert.equal(allowed.calls[0].query.sendUpdates, "all");
  assert.equal(allowed.output.data.notifications_suppressed, undefined);
  const fromNode = await runWithResponses("create_event", args, [{ body: TAGGED_EVENT }]);
  assert.equal(fromNode.calls[0].query.sendUpdates, "all");
});

test("send_updates is forced to none for tool updates, deletes and quick adds too", async () => {
  const update = await runAsTool("update_event", { event_id: "e1", summary: "x", send_updates: "all" }, [{ body: TAGGED_EVENT }, { body: TAGGED_EVENT }]);
  assert.equal(update.calls[1].query.sendUpdates, "none");
  const deletion = await runAsTool("delete_event", { event_id: "e1", send_updates: "externalOnly" }, [{ body: TAGGED_EVENT }, { status: 204 }]);
  assert.equal(deletion.calls[1].query.sendUpdates, "none");
  const quickAdd = await runAsTool("quick_add", { text: "Lunch with a@example.com", send_updates: "all" }, [{ body: { id: "q1" } }, { body: TAGGED_EVENT }]);
  assert.equal(quickAdd.calls[0].query.sendUpdates, "none");
});

test("tool-created events are always tagged graphrt_created=1", async () => {
  const { calls } = await runAsTool("create_event", { ...TIMED_ARGS, private_properties: { graphrt_created: "0" } }, [{ body: TAGGED_EVENT }]);
  assert.equal(calls[0].json.extendedProperties.private.graphrt_created, "1");
});

test("tools may update and delete only events this plugin created", async () => {
  for (const [operationName, args] of [["update_event", { event_id: "e1", summary: "x" }], ["delete_event", { event_id: "e1" }]]) {
    const { error, calls } = await runCapturingFailure(operationName, args, [{ body: FOREIGN_EVENT }], TEST_ENVIRONMENT, "tool");
    assert.ok(error && isPermissionDenied(error), `${operationName}: ${error?.message}`);
    assert.match(error.message, /created by this plugin/);
    assert.deepEqual(calls.map((call) => call.method), ["GET"], operationName);
  }
  const update = await runAsTool("update_event", { event_id: "e1", summary: "x" }, [{ body: TAGGED_EVENT }, { body: TAGGED_EVENT }]);
  assert.deepEqual(update.calls.map((call) => call.method), ["GET", "PATCH"]);
  const deletion = await runAsTool("delete_event", { event_id: "e1" }, [{ body: TAGGED_EVENT }, { status: 204 }]);
  assert.deepEqual(deletion.calls.map((call) => call.method), ["GET", "DELETE"]);
  assert.equal(deletion.output.data.deleted, true);
});

test("a tool delete of an already-cancelled tagged event succeeds without a DELETE", async () => {
  const { output, calls } = await runAsTool("delete_event", { event_id: "e1" }, [{ body: { ...TAGGED_EVENT, status: "cancelled" } }]);
  assert.equal(calls.length, 1);
  assert.equal(output.data.already_deleted, true);
});

test("a tool delete of an already-cancelled event reports already_deleted even when the tag is gone", async () => {
  const cancelledWithoutTag = { id: "e1", status: "cancelled" };
  const { output, calls } = await runAsTool("delete_event", { event_id: "e1" }, [{ body: cancelledWithoutTag }]);
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
  assert.equal(output.data.already_deleted, true);
});

test("a tool update cannot strip the plugin's own tag through private_properties", async () => {
  const { calls } = await runAsTool("update_event", { event_id: "e1", private_properties: { graphrt_created: "0", note: "x" } }, [
    { body: TAGGED_EVENT },
    { body: TAGGED_EVENT },
  ]);
  assert.deepEqual(calls[1].json.extendedProperties.private, { graphrt_created: "1", note: "x" });
});

test("a node update re-applies the tag on events that already carry it, and adds none otherwise", async () => {
  const tagged = await runWithResponses("update_event", { event_id: "e1", private_properties: { graphrt_created: "no" } }, [{ body: TAGGED_EVENT }, { body: TAGGED_EVENT }]);
  assert.equal(tagged.calls[1].json.extendedProperties.private.graphrt_created, "1");
  const untagged = await runWithResponses("update_event", { event_id: "e1", private_properties: { note: "x" } }, [{ body: FOREIGN_EVENT }, { body: FOREIGN_EVENT }]);
  assert.equal(untagged.calls[1].json.extendedProperties.private.graphrt_created, undefined);
});

test("tool updates and deletes send If-Match with the etag they checked; nodes do not", async () => {
  const taggedWithEtag = { ...TAGGED_EVENT, etag: '"3181161784712000"' };
  const update = await runAsTool("update_event", { event_id: "e1", summary: "x" }, [{ body: taggedWithEtag }, { body: taggedWithEtag }]);
  assert.equal(update.calls[1].headers["if-match"], '"3181161784712000"');
  const deletion = await runAsTool("delete_event", { event_id: "e1" }, [{ body: taggedWithEtag }, { status: 204 }]);
  assert.equal(deletion.calls[1].headers["if-match"], '"3181161784712000"');
  const fromNode = await runWithResponses("update_event", { event_id: "e1", summary: "x" }, [{ body: taggedWithEtag }]);
  assert.equal(fromNode.calls[0].headers["if-match"], undefined);
});

test("a tool update or delete of an event changed since the check fails conflict", async () => {
  const taggedWithEtag = { ...TAGGED_EVENT, etag: '"1"' };
  const preconditionFailed = { status: 412, body: { error: { code: 412, message: "Precondition Failed", errors: [{ reason: "conditionNotMet" }] } } };
  const changedEvent = { ...taggedWithEtag, etag: '"2"' };
  const cases = [
    ["update_event", { event_id: "e1", summary: "x" }, ["GET", "PATCH"]],
    ["delete_event", { event_id: "e1" }, ["GET", "DELETE", "GET"]],
  ];
  for (const [operationName, args, expectedMethods] of cases) {
    const responses = [{ body: taggedWithEtag }, preconditionFailed, { body: changedEvent }];
    const { error, calls } = await runCapturingFailure(operationName, args, responses, TEST_ENVIRONMENT, "tool");
    assert.equal(error?.kind, "conflict", `${operationName}: ${error?.message}`);
    assert.match(error.message, /changed since/);
    assert.equal(error.retryable, false);
    assert.deepEqual(calls.map((call) => call.method), expectedMethods, operationName);
  }
});

test("a tool delete that gets 412 because its own earlier attempt already deleted the event reports already_deleted", async () => {
  const taggedWithEtag = { ...TAGGED_EVENT, etag: '"1"' };
  const preconditionFailed = { status: 412, body: { error: { code: 412, message: "Precondition Failed", errors: [{ reason: "conditionNotMet" }] } } };
  const { output } = await runAsTool("delete_event", { event_id: "e1" }, [{ body: taggedWithEtag }, preconditionFailed, { body: { id: "e1", status: "cancelled" } }]);
  assert.equal(output.data.already_deleted, true);
});

test("workflow nodes update and delete any event without a pre-check", async () => {
  const update = await runWithResponses("update_event", { event_id: "e1", summary: "x" }, [{ body: FOREIGN_EVENT }]);
  assert.deepEqual(update.calls.map((call) => call.method), ["PATCH"]);
  const deletion = await runWithResponses("delete_event", { event_id: "e1" }, [{ status: 204 }]);
  assert.deepEqual(deletion.calls.map((call) => call.method), ["DELETE"]);
});

test("tool api_request is GET-only and refuses encoded path tricks", async () => {
  await assert.rejects(runAsTool("api_request", { method: "POST", path: "/calendars", body: {} }), isPermissionDenied);
  await assert.rejects(runAsTool("api_request", { path: `/calendars/primary/%2e%2e/${OTHER_CALENDAR}/events` }), (error) => error.kind === "invalid_input");
  await assert.rejects(runAsTool("api_request", { path: "/calendars/primary%2Fevents" }), (error) => error.kind === "invalid_input");
  const allowed = await runAsTool("api_request", { path: "/calendars/primary/events", query: { maxResults: 1 } }, [{ body: { items: [] } }]);
  assert.equal(allowed.calls.length, 1);
  const unscoped = await runAsTool("api_request", { path: "/colors" }, [{ body: {} }]);
  assert.equal(unscoped.calls.length, 1);
});

test("list_calendars marks which calendars agent tools may use", async () => {
  const calendarList = { items: [{ id: "me@example.com", primary: true }, { id: OTHER_CALENDAR }, { id: "team@group.calendar.google.com" }] };
  const environment = { ...TEST_ENVIRONMENT, GOOGLE_CALENDAR_TOOL_ALLOWED_IDS: "primary,team@group.calendar.google.com" };
  const { output } = await runAsTool("list_calendars", {}, [{ body: calendarList }], environment);
  assert.deepEqual(output.data.calendars.map((calendar) => calendar.agent_tool_allowed), [true, false, true]);
});

test("the manifest lists both guardrail env vars and offers every operation as a tool", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.ok(manifest.permissions.env.includes("GOOGLE_CALENDAR_TOOL_ALLOWED_IDS"));
  assert.ok(manifest.permissions.env.includes("GOOGLE_CALENDAR_TOOL_SEND_UPDATES"));
  assert.equal(manifest.tools.length, manifest.nodes.length);
});
