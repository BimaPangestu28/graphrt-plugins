import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveEventId, encodeBase32Hex, generateRandomEventId } from "../lib/event-ids.mjs";
import { CALENDAR_BASE_PATH, calendarErrorResponse, runCapturingFailure, runWithResponses } from "./helpers.mjs";

const TIMED_ARGS = { summary: "Demo", start: "2026-11-20T09:00:00+07:00", end: "2026-11-20T10:00:00+07:00" };
const serverError = { status: 503, headers: { "retry-after": "0" }, body: { error: { code: 503, message: "Backend Error", errors: [{ reason: "backendError" }] } } };
const duplicateError = calendarErrorResponse(409, "duplicate", "The requested identifier already exists.");

test("base32hex encoding matches RFC 4648 test vectors (lowercase, no padding)", () => {
  const vectors = [["", ""], ["f", "co"], ["fo", "cpng"], ["foo", "cpnmu"], ["foob", "cpnmuog"], ["fooba", "cpnmuoj1"], ["foobar", "cpnmuoj1e8"]];
  for (const [input, expected] of vectors) assert.equal(encodeBase32Hex(Buffer.from(input)), expected);
});

test("derived and random event ids satisfy Google's id rules", () => {
  const derivedId = deriveEventId("order-1");
  assert.match(derivedId, /^[a-v0-9]{52}$/);
  assert.equal(deriveEventId("order-1"), derivedId);
  assert.notEqual(deriveEventId("order-2"), derivedId);
  assert.equal(generateRandomEventId(() => new Uint8Array(20)), "0".repeat(32));
  assert.match(generateRandomEventId(), /^[a-v0-9]{32}$/);
});

test("a retried insert with an idempotency key reuses the id; a 409 duplicate then counts as success", async () => {
  const eventId = deriveEventId("booking-7");
  const existingEvent = { id: eventId, status: "confirmed", summary: "Demo", extendedProperties: { private: { graphrt_created: "1" } } };
  const { output, calls } = await runWithResponses("create_event", { ...TIMED_ARGS, idempotency_key: "booking-7" }, [serverError, duplicateError, { body: existingEvent }]);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${decodeURIComponent(call.path)}`),
    [`POST ${CALENDAR_BASE_PATH}/calendars/primary/events`, `POST ${CALENDAR_BASE_PATH}/calendars/primary/events`, `GET ${CALENDAR_BASE_PATH}/calendars/primary/events/${eventId}`],
  );
  assert.equal(calls[0].json.id, eventId);
  assert.equal(calls[1].json.id, eventId);
  assert.equal(output.data.already_existed, true);
  assert.equal(output.data.event_id, eventId);
});

test("a fresh insert reports already_existed false", async () => {
  const { output } = await runWithResponses("create_event", TIMED_ARGS, [{ body: { id: "abc12", status: "confirmed" } }]);
  assert.equal(output.data.already_existed, false);
  assert.equal(output.data.send_updates, "none");
});

test("a duplicate id whose event was deleted is already_exists, not success", async () => {
  await assert.rejects(
    runWithResponses("create_event", { ...TIMED_ARGS, idempotency_key: "k" }, [duplicateError, { body: { id: deriveEventId("k"), status: "cancelled" } }]),
    (error) => error.kind === "already_exists" && /deleted/.test(error.message),
  );
});

test("with a random id, a failure after all retries is not retryable and names the id to check", async () => {
  await assert.rejects(runWithResponses("create_event", TIMED_ARGS, [serverError, serverError, serverError]), (error) => {
    assert.equal(error.retryable, false);
    assert.match(error.message, /outcome unknown/);
    assert.match(error.message, /get_event with event_id [a-v0-9]{32}/);
    return true;
  });
});

test("with an idempotency key, a failure after all retries stays retryable", async () => {
  await assert.rejects(
    runWithResponses("create_event", { ...TIMED_ARGS, idempotency_key: "k2" }, [serverError, serverError, serverError]),
    (error) => error.kind === "api_error" && error.retryable === true,
  );
});

test("insert rejections that cannot have created anything pass through unchanged", async () => {
  await assert.rejects(
    runWithResponses("create_event", TIMED_ARGS, [calendarErrorResponse(400, "timeRangeEmpty", "The specified time range is empty.")]),
    (error) => error.kind === "invalid_input" && !/outcome unknown/.test(error.message),
  );
});

test("book_slot re-checks free/busy for exactly the event's time, then inserts", async () => {
  const { output, calls } = await runWithResponses("create_event", { ...TIMED_ARGS, book_slot: true }, [
    { body: { calendars: { primary: { busy: [{ start: "2026-11-20T01:00:00Z", end: "2026-11-20T02:00:00Z" }] } } } },
    { body: { id: "abcde", status: "confirmed" } },
  ]);
  assert.equal(decodeURIComponent(calls[0].path), `${CALENDAR_BASE_PATH}/freeBusy`);
  assert.deepEqual(calls[0].json, { timeMin: "2026-11-20T02:00:00.000Z", timeMax: "2026-11-20T03:00:00.000Z", items: [{ id: "primary" }] });
  assert.equal(calls[1].method, "POST");
  assert.equal(output.data.already_existed, false);
});

test("book_slot fails conflict without inserting when the slot was taken", async () => {
  const takenSlot = { body: { calendars: { primary: { busy: [{ start: "2026-11-20T02:30:00Z", end: "2026-11-20T04:00:00Z" }] } } } };
  const { error, calls } = await runCapturingFailure("create_event", { ...TIMED_ARGS, book_slot: true }, [takenSlot]);
  assert.equal(error.kind, "conflict");
  assert.equal(calls.length, 1, "only the free/busy check, no insert");
});

test("book_slot with an idempotency key returns the event an earlier run already booked", async () => {
  const eventId = deriveEventId("slot-1");
  const takenByUs = { body: { calendars: { primary: { busy: [{ start: "2026-11-20T02:00:00Z", end: "2026-11-20T03:00:00Z" }] } } } };
  const { output, calls } = await runWithResponses("create_event", { ...TIMED_ARGS, book_slot: true, idempotency_key: "slot-1" }, [
    takenByUs,
    { body: { id: eventId, status: "confirmed", start: { dateTime: "2026-11-20T09:00:00+07:00" }, end: { dateTime: "2026-11-20T03:00:00Z" } } },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, "GET");
  assert.equal(output.data.already_existed, true);
  const otherEventHere = runWithResponses("create_event", { ...TIMED_ARGS, book_slot: true, idempotency_key: "slot-1" }, [takenByUs, { status: 404, body: { error: { code: 404, message: "Not Found", errors: [{ reason: "notFound" }] } } }]);
  await assert.rejects(otherEventHere, (error) => error.kind === "conflict");
});

test("book_slot with a key fails conflict when the earlier event sits at another time and the slot is taken", async () => {
  const eventId = deriveEventId("slot-2");
  const taken = { body: { calendars: { primary: { busy: [{ start: "2026-11-20T02:00:00Z", end: "2026-11-20T03:00:00Z" }] } } } };
  const elsewhere = { id: eventId, status: "confirmed", start: { dateTime: "2026-11-21T09:00:00+07:00" }, end: { dateTime: "2026-11-21T10:00:00+07:00" } };
  const { error, calls } = await runCapturingFailure("create_event", { ...TIMED_ARGS, book_slot: true, idempotency_key: "slot-2" }, [taken, { body: elsewhere }]);
  assert.equal(error?.kind, "conflict", error?.message);
  assert.match(error.message, new RegExp(`${eventId}.*2026-11-21T09:00:00\\+07:00`));
  assert.equal(calls.length, 2, "no insert");
});

test("book_slot with a key fails conflict when the slot is free but the key already booked another time", async () => {
  const eventId = deriveEventId("slot-3");
  const free = { body: { calendars: { primary: { busy: [] } } } };
  const elsewhere = { id: eventId, status: "confirmed", start: { dateTime: "2026-11-21T02:00:00Z" }, end: { dateTime: "2026-11-21T03:00:00Z" } };
  const { error, calls } = await runCapturingFailure("create_event", { ...TIMED_ARGS, book_slot: true, idempotency_key: "slot-3" }, [free, duplicateError, { body: elsewhere }]);
  assert.equal(error?.kind, "conflict", error?.message);
  assert.match(error.message, /already booked/);
  assert.deepEqual(calls.map((call) => call.method), ["POST", "POST", "GET"]);
});

test("book_slot with a key returns the duplicate as already_existed when it is at the requested slot", async () => {
  const eventId = deriveEventId("slot-4");
  const free = { body: { calendars: { primary: { busy: [] } } } };
  const sameSlot = { id: eventId, status: "confirmed", start: { dateTime: "2026-11-20T02:00:00Z" }, end: { dateTime: "2026-11-20T03:00:00Z" } };
  const { output } = await runWithResponses("create_event", { ...TIMED_ARGS, book_slot: true, idempotency_key: "slot-4" }, [free, duplicateError, { body: sameSlot }]);
  assert.equal(output.data.already_existed, true);
});

test("book_slot refuses to book when free/busy reports an error for the calendar", async () => {
  await assert.rejects(
    runWithResponses("create_event", { ...TIMED_ARGS, book_slot: true }, [{ body: { calendars: { primary: { errors: [{ reason: "internalError" }] } } } }]),
    (error) => error.kind === "api_error" && /nothing was created/.test(error.message),
  );
});

test("update_event server failures are not retried and say how to check", async () => {
  const { error, calls } = await runCapturingFailure("update_event", { event_id: "e1", summary: "x" }, [serverError, { body: {} }]);
  assert.equal(calls.length, 1);
  assert.equal(error.retryable, false);
  assert.match(error.message, /get_event with event_id e1/);
});

test("update_event with private_properties merges them into the existing ones", async () => {
  const currentEvent = { id: "e1", extendedProperties: { private: { graphrt_created: "1", booking_id: "42" } } };
  const { calls } = await runWithResponses("update_event", { event_id: "e1", private_properties: { status: "paid" } }, [{ body: currentEvent }, { body: currentEvent }]);
  assert.equal(calls[0].method, "GET");
  assert.deepEqual(calls[1].json, { extendedProperties: { private: { graphrt_created: "1", booking_id: "42", status: "paid" } } });
});

test("update_event can add a Meet link with conferenceDataVersion=1", async () => {
  const { calls } = await runWithResponses("update_event", { event_id: "e1", add_google_meet: true }, [{ body: {} }]);
  assert.equal(calls[0].query.conferenceDataVersion, "1");
  assert.equal(calls[0].json.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
  assert.ok(calls[0].json.conferenceData.createRequest.requestId);
});

test("delete_event treats 410 deleted as success and 404 as not_found", async () => {
  const { output } = await runWithResponses("delete_event", { event_id: "e1" }, [calendarErrorResponse(410, "deleted", "Resource has been deleted")]);
  assert.deepEqual(output.data, { event_id: "e1", deleted: true, already_deleted: true, send_updates: "none" });
  await assert.rejects(runWithResponses("delete_event", { event_id: "e1" }, [calendarErrorResponse(404, "notFound", "Not Found")]), (error) => error.kind === "not_found");
});

test("quick_add tags the new event without notifying anyone", async () => {
  const createdEvent = { id: "q1", summary: "Lunch" };
  const taggedEvent = { ...createdEvent, extendedProperties: { private: { graphrt_created: "1" } } };
  const { output, calls } = await runWithResponses("quick_add", { text: "Lunch tomorrow noon" }, [{ body: createdEvent }, { body: taggedEvent }]);
  assert.equal(calls[1].method, "PATCH");
  assert.equal(decodeURIComponent(calls[1].path), `${CALENDAR_BASE_PATH}/calendars/primary/events/q1`);
  assert.equal(calls[1].query.sendUpdates, "none");
  assert.deepEqual(calls[1].json, { extendedProperties: { private: { graphrt_created: "1" } } });
  assert.equal(output.data.created_by_plugin, true);
  assert.equal(output.data.warning, undefined);
});

test("quick_add still returns the event when tagging fails, with a warning", async () => {
  const { output } = await runWithResponses("quick_add", { text: "Lunch" }, [{ body: { id: "q1" } }, calendarErrorResponse(400, "invalid", "bad")]);
  assert.equal(output.data.event_id, "q1");
  assert.match(output.data.warning, /could not be tagged/);
});

test("quick_add is never retried after an unknown outcome", async () => {
  const { error, calls } = await runCapturingFailure("quick_add", { text: "Lunch" }, [serverError, { body: { id: "dup" } }]);
  assert.equal(calls.length, 1);
  assert.equal(error.retryable, false);
  assert.match(error.message, /list_events/);
});
