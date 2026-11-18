import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGoogleError } from "../lib/google-errors.mjs";
import { runWithResponses } from "./helpers.mjs";

function googleError(code, status, reason, message = "m") {
  return { error: { code, message, status, details: reason ? [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason }] : undefined } };
}

for (const [httpStatus, grpcStatus, reason, expectedKind] of [
  [401, "UNAUTHENTICATED", undefined, "auth_error"],
  [403, "PERMISSION_DENIED", undefined, "permission_denied"],
  [403, "PERMISSION_DENIED", "SERVICE_DISABLED", "permission_denied"],
  [404, "NOT_FOUND", undefined, "not_found"],
  [400, "INVALID_ARGUMENT", undefined, "invalid_input"],
  [400, "FAILED_PRECONDITION", undefined, "invalid_input"],
  [429, "RESOURCE_EXHAUSTED", "RATE_LIMIT_EXCEEDED", "rate_limited"],
  [403, "PERMISSION_DENIED", "RATE_LIMIT_EXCEEDED", "rate_limited"],
  [500, "INTERNAL", undefined, undefined],
]) {
  test(`parseGoogleError maps ${httpStatus} ${grpcStatus} ${reason ?? ""} to ${expectedKind}`, () => {
    assert.equal(parseGoogleError(httpStatus, googleError(httpStatus, grpcStatus, reason)).kind, expectedKind);
  });
}

test("parseGoogleError keeps the message, status and reason, and hints at disabled APIs", () => {
  const parsed = parseGoogleError(403, googleError(403, "PERMISSION_DENIED", "SERVICE_DISABLED", "Sheets API has not been used"));
  assert.match(parsed.message, /Sheets API has not been used \(PERMISSION_DENIED, SERVICE_DISABLED\)/);
  assert.match(parsed.message, /Enable the API/);
  assert.deepEqual(parseGoogleError(502, { text: "Bad gateway" }), {});
});

test("an unknown spreadsheet is not_found end to end; a v1-style errors[].reason also works", async () => {
  await assert.rejects(
    runWithResponses("get_spreadsheet", { spreadsheet_id: "missing" }, [{ status: 404, body: googleError(404, "NOT_FOUND", undefined, "Requested entity was not found.") }]),
    (error) => error.kind === "not_found" && /Requested entity was not found/.test(error.message),
  );
  assert.equal(parseGoogleError(403, { error: { code: 403, message: "m", errors: [{ reason: "userRateLimitExceeded" }] } }).kind, "rate_limited");
});

test("rate limits on reads are retried", async () => {
  const { output } = await runWithResponses(
    "read_range",
    { spreadsheet_id: "s", range: "A1" },
    [{ status: 429, headers: { "retry-after": "0" }, body: googleError(429, "RESOURCE_EXHAUSTED", "RATE_LIMIT_EXCEEDED") }, { body: { range: "Sheet1!A1", values: [["x"]] } }],
  );
  assert.deepEqual(output.data.values, [["x"]]);
});
