import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCalendarError } from "../lib/client.mjs";
import { calendarErrorResponse, runWithResponses } from "./helpers.mjs";

// Calendar v3 errors carry `errors[].reason` and usually no gRPC `status`.
for (const [httpStatus, reason, expectedKind, expectedRetryable] of [
  [401, "authError", "auth_error", undefined],
  [403, "forbidden", "permission_denied", undefined],
  [403, "forbiddenForNonOrganizer", "permission_denied", undefined],
  [403, "rateLimitExceeded", "rate_limited", undefined],
  [403, "userRateLimitExceeded", "rate_limited", undefined],
  [429, "rateLimitExceeded", "rate_limited", undefined],
  [403, "quotaExceeded", "rate_limited", false],
  [409, "duplicate", "already_exists", false],
  [410, "deleted", "already_deleted", false],
  [412, "conditionNotMet", "conflict", false],
  [403, "accessNotConfigured", "permission_denied", undefined],
]) {
  test(`parseCalendarError maps ${httpStatus} ${reason} to ${expectedKind}`, () => {
    const parsedError = parseCalendarError(httpStatus, calendarErrorResponse(httpStatus, reason, "m").body);
    const effectiveKind = parsedError.kind ?? { 401: "auth_error", 403: "permission_denied" }[httpStatus];
    assert.equal(effectiveKind, expectedKind);
    assert.equal(parsedError.retryable, expectedRetryable);
  });
}

test("parseCalendarError keeps the reason in the message and ignores non-Google bodies", () => {
  assert.match(parseCalendarError(409, calendarErrorResponse(409, "duplicate", "The requested identifier already exists.").body).message, /already exists.*duplicate/);
  assert.deepEqual(parseCalendarError(502, { text: "Bad gateway" }), {});
});

test("end to end: unknown event is not_found, a disabled API is permission_denied with a hint", async () => {
  await assert.rejects(runWithResponses("get_event", { event_id: "nope1" }, [calendarErrorResponse(404, "notFound", "Not Found")]), (error) => error.kind === "not_found");
  await assert.rejects(
    runWithResponses("list_calendars", {}, [calendarErrorResponse(403, "accessNotConfigured", "Google Calendar API has not been used in project 1")]),
    (error) => error.kind === "permission_denied" && /Enable the API/.test(error.message),
  );
});

test("rate limits on reads are retried", async () => {
  const { output } = await runWithResponses("get_event", { event_id: "e1" }, [
    { ...calendarErrorResponse(403, "rateLimitExceeded", "Rate Limit Exceeded"), headers: { "retry-after": "0" } },
    { body: { id: "e1" } },
  ]);
  assert.equal(output.data.event_id, "e1");
});
