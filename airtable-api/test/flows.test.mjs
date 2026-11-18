import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAirtableError, RATE_LIMIT_WAIT_MS } from "../lib/client.mjs";
import { airtableError, isInvalidInput, RECORD_ID, runWithResponses } from "./helpers.mjs";

const tenRecords = Array.from({ length: 10 }, (_, index) => ({ fields: { Name: `n${index}` } }));

// Each case: operation, args -> invalid_input message pattern (no request is sent).
const VALIDATION_CASES = [
  ["create_records", { table: "T", records: [] }, /1-10 items/],
  ["create_records", { table: "T", records: [...tenRecords, { fields: {} }] }, /at most 10 items/],
  ["create_records", { table: "T", records: [{ Name: "flat" }] }, /records\[0\]\.fields/],
  ["create_records", { table: "T", records: [{ id: RECORD_ID, fields: {} }] }, /must not have an id/],
  ["update_records", { table: "T", records: [{ fields: { a: 1 } }] }, /records\[0\]\.id` is required/],
  ["update_records", { table: "T", records: [{ id: "rec1/../x", fields: {} }] }, /Invalid record id/],
  ["upsert_records", { table: "T", records: [{ fields: {} }], fields_to_merge_on: [] }, /1-3 field/],
  ["upsert_records", { table: "T", records: [{ fields: {} }], fields_to_merge_on: ["a", "b", "c", "d"] }, /at most 3 items/],
  ["get_record", { table: "T", record_id: "../meta" }, /Invalid record id/],
  ["get_record", { table: "..", record_id: RECORD_ID }, /Invalid id/],
  ["list_records", { table: "T", base_id: "app/../x" }, /Invalid base id/],
  ["list_records", { table: "T", sort: [{ direction: "desc" }] }, /sort\[0\]\.field/],
  ["list_records", { table: "T", sort: [{ field: "a", direction: "down" }] }, /"asc" or "desc"/],
  ["find_records", { table: "T", where: {} }, /at least one/],
  ["find_records", { table: "T", where: { "a}b": "x" } }, /no braces/],
  ["find_records", { table: "T", where: { Name: "a\rb" } }, /control characters/],
  ["find_records", { table: "T", where: { Tags: ["a"] } }, /Cannot compare/],
  ["find_records", { table: "T", where: { Name: "C:\\path" } }, /backslash.*list_records/],
  ["find_records", { table: "T", where: { "a\\b": "x" } }, /backslash.*list_records/],
  ["find_records", { table: "T", where: { Name: "" }, match: "contains" }, /contains/],
  ["upsert_records", { table: "T", records: [{ fields: { Name: "Ana" } }], fields_to_merge_on: ["Email"] }, /records\[0\].*"Email"/],
  ["upsert_records", { table: "T", records: [{ fields: { Email: "a@b.co" } }, { fields: { Email: " " } }], fields_to_merge_on: ["Email"] }, /records\[1\].*"Email"/],
  ["upsert_records", { table: "T", records: [{ fields: { Email: "a@b.co", Phone: null } }], fields_to_merge_on: ["Email", "Phone"] }, /records\[0\].*"Phone"/],
];

for (const [operationName, args, messagePattern] of VALIDATION_CASES) {
  test(`${operationName} rejects ${JSON.stringify(args).slice(0, 70)}`, async () => {
    await assert.rejects(runWithResponses(operationName, args, []), (error) => isInvalidInput(error) && messagePattern.test(error.message));
  });
}

test("a missing base id (no argument, no AIRTABLE_BASE_ID) is invalid_input", async () => {
  await assert.rejects(
    runWithResponses("list_records", { table: "T" }, [], { environment: { AIRTABLE_TOKEN: "patX" } }),
    (error) => isInvalidInput(error) && /AIRTABLE_BASE_ID/.test(error.message),
  );
});

test("delete_records validates every id before sending", async () => {
  await assert.rejects(
    runWithResponses("delete_records", { table: "T", record_ids: [RECORD_ID, "recX&records[]=recY"] }, [], { source: "node" }),
    (error) => isInvalidInput(error) && /Invalid record id/.test(error.message),
  );
});

// Each case: status, type -> kind.
const ERROR_CASES = [
  [401, "AUTHENTICATION_REQUIRED", "auth_error"],
  [403, "INVALID_PERMISSIONS", "permission_denied"],
  [403, "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND", "permission_denied"],
  [404, "NOT_FOUND", "not_found"],
  [404, "MODEL_ID_NOT_FOUND", "not_found"],
  [429, "RATE_LIMIT_REACHED", "rate_limited"],
  [422, "INVALID_REQUEST_UNKNOWN", undefined],
  [422, "INVALID_MULTIPLE_CHOICE_OPTIONS", undefined],
];

for (const [status, type, expectedKind] of ERROR_CASES) {
  test(`parseAirtableError maps ${status} ${type} to ${expectedKind ?? "the status default"}`, () => {
    assert.equal(parseAirtableError(status, airtableError(status, type).body, new Headers()).kind, expectedKind);
  });
}

test("parseAirtableError reads flat errors, adds hints and defaults a 429 wait to 30 s", () => {
  assert.equal(parseAirtableError(404, { error: "NOT_FOUND" }).kind, "not_found");
  assert.match(parseAirtableError(403, airtableError(403, "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND", "Invalid permissions").body).message, /Check the base id and table name/);
  assert.equal(parseAirtableError(429, {}, new Headers()).retryAfterMs, RATE_LIMIT_WAIT_MS);
  assert.equal(RATE_LIMIT_WAIT_MS, 30000);
  assert.equal(parseAirtableError(429, {}, new Headers({ "retry-after": "5" })).retryAfterMs, undefined);
  assert.deepEqual(parseAirtableError(502, { text: "Bad gateway" }), {});
  assert.equal(parseAirtableError(413, { text: "Request Entity Too Large" }).kind, "invalid_input");
});

test("an invalid token is auth_error end to end, a 422 is invalid_input, and the token is never echoed", async () => {
  await assert.rejects(
    runWithResponses("list_bases", {}, [airtableError(401, "AUTHENTICATION_REQUIRED", "Authentication required for patTestSecretToken.123")]),
    (error) => error.kind === "auth_error" && /Authentication required/.test(error.message) && !error.message.includes("patTestSecretToken.123"),
  );
  await assert.rejects(runWithResponses("create_records", { table: "T", records: [{ fields: { Stage: "x" } }] }, [airtableError(422, "INVALID_MULTIPLE_CHOICE_OPTIONS")]), isInvalidInput);
});

test("a 429 is waited out once and then fails rate_limited", async () => {
  const rateLimited = { ...airtableError(429, "RATE_LIMIT_REACHED"), headers: { "retry-after": "0" } };
  const recovered = await runWithResponses("create_records", { table: "T", records: [{ fields: {} }] }, [rateLimited, { body: { records: [{ id: RECORD_ID }] } }]);
  assert.equal(recovered.calls.length, 2);
  await assert.rejects(
    runWithResponses("list_records", { table: "T" }, [rateLimited, rateLimited, { body: {} }]),
    (error) => error.kind === "rate_limited" && error.retryable === true,
  );
});

test("create_records is not retried after a 5xx: not retryable and says how to check", async () => {
  const { calls } = await runWithResponses("list_bases", {}, [{ body: {} }]);
  assert.equal(calls.length, 1);
  await assert.rejects(
    runWithResponses("create_records", { table: "T", records: [{ fields: {} }] }, [airtableError(503, "RETRIABLE_ERROR"), { body: {} }]),
    (error) => error.retryable === false && /outcome unknown/.test(error.message) && /find_records/.test(error.message),
  );
});

test("upsert_records and update_records (idempotent) are retried after a 5xx", async () => {
  const serverError = { ...airtableError(503, "RETRIABLE_ERROR"), headers: { "retry-after": "0" } };
  for (const [operationName, args] of [
    ["upsert_records", { table: "T", records: [{ fields: { Email: "a@b.co" } }], fields_to_merge_on: ["Email"] }],
    ["update_records", { table: "T", records: [{ id: RECORD_ID, fields: { a: 1 } }] }],
  ]) {
    const { calls, output } = await runWithResponses(operationName, args, [serverError, { body: { records: [] } }]);
    assert.equal(calls.length, 2, operationName);
    assert.deepEqual(output.data, { records: [] });
  }
});

test("api_request is read-only for tools", async () => {
  await assert.rejects(runWithResponses("api_request", { method: "DELETE", path: "/appAAAAAAAAAAAAAA/T" }), (error) => error.kind === "permission_denied");
});
