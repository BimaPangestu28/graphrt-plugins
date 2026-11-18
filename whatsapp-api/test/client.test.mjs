import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWhatsAppError, createWhatsAppClient } from "../lib/client.mjs";
import { normalizePhoneNumber } from "../lib/phone-number.mjs";
import { runWithResponses, runExpectingFailure, rejectsWithKind } from "./helpers.mjs";

const noHeaders = new Headers();

for (const [code, expectedKind] of [
  [4, "rate_limited"],
  [80007, "rate_limited"],
  [130429, "rate_limited"],
  [131056, "rate_limited"],
  [0, "auth_error"],
  [190, "auth_error"],
  [3, "permission_denied"],
  [10, "permission_denied"],
  [200, "permission_denied"],
  [368, "permission_denied"],
  [131005, "permission_denied"],
  [131031, "permission_denied"],
  [131048, "permission_denied"],
  [132015, "permission_denied"],
  [132016, "permission_denied"],
  [100, "invalid_input"],
  [131008, "invalid_input"],
  [131009, "invalid_input"],
  [131021, "invalid_input"],
  [131047, "invalid_input"],
  [131051, "invalid_input"],
  [131053, "invalid_input"],
  [132000, "invalid_input"],
  [132001, "invalid_input"],
  [132012, "invalid_input"],
  [133010, "invalid_input"],
]) {
  test(`parseWhatsAppError maps code ${code} to ${expectedKind}`, () => {
    assert.equal(parseWhatsAppError(400, { error: { code, message: "m" } }, noHeaders).kind, expectedKind);
  });
}

test("parseWhatsAppError adds a template hint for code 131047 (outside the 24 h window) and never retries it", () => {
  const parsed = parseWhatsAppError(400, { error: { code: 131047, message: "Re-engagement message" } }, noHeaders);
  assert.equal(parsed.retryable, false);
  assert.match(parsed.message, /24 h/);
  assert.match(parsed.message, /send_template/);
});

test("parseWhatsAppError does not retry the per-recipient pair rate limit 131056", () => {
  assert.equal(parseWhatsAppError(400, { error: { code: 131056, message: "pair" } }, noHeaders).retryable, false);
});

test("parseWhatsAppError includes error_data.details, codes and trace id", () => {
  const parsed = parseWhatsAppError(
    400,
    { error: { code: 131009, message: "(#131009) Parameter value is not valid", error_data: { details: "to is invalid" }, fbtrace_id: "TRACE" } },
    noHeaders,
  );
  assert.match(parsed.message, /Parameter value is not valid/);
  assert.match(parsed.message, /to is invalid/);
  assert.match(parsed.message, /code 131009/);
  assert.match(parsed.message, /TRACE/);
});

test("parseWhatsAppError maps code 100 subcode 33 to not_found", () => {
  assert.equal(parseWhatsAppError(400, { error: { code: 100, error_subcode: 33, message: "m" } }, noHeaders).kind, "not_found");
});

test("parseWhatsAppError reads the regain-access estimate from X-Business-Use-Case-Usage", () => {
  const usageHeader = JSON.stringify({ 222: [{ type: "whatsapp", estimated_time_to_regain_access: 2 }] });
  const parsed = parseWhatsAppError(400, { error: { code: 80007, message: "too many" } }, new Headers({ "x-business-use-case-usage": usageHeader }));
  assert.equal(parsed.retryAfterMs, 120000);
});

test("parseWhatsAppError leaves non-Graph bodies to the default mapping", () => {
  assert.deepEqual(parseWhatsAppError(502, { text: "Bad gateway" }, noHeaders), {});
});

test("createWhatsAppClient rejects a malformed WHATSAPP_GRAPH_VERSION", () => {
  assert.throws(() => createWhatsAppClient({ accessToken: "t", environment: { WHATSAPP_GRAPH_VERSION: "26" } }), (error) => error.kind === "invalid_input");
});

test("WHATSAPP_GRAPH_VERSION changes the base path", async () => {
  const { calls } = await runWithResponses("get_business_profile", {}, [{ body: { data: [{}] } }], {
    WHATSAPP_ACCESS_TOKEN: "t",
    WHATSAPP_PHONE_NUMBER_ID: "111",
    WHATSAPP_GRAPH_VERSION: "v25.0",
  });
  assert.equal(calls[0].path, "/v25.0/111/whatsapp_business_profile");
});

test("a send rejected as outside the 24 h window surfaces as invalid_input with the hint, after one attempt", async () => {
  const windowError = { status: 400, body: { error: { code: 131047, message: "Re-engagement message" } } };
  const { error, calls } = await runExpectingFailure("send_text", { to: "6281234567890", body: "hi" }, [windowError, windowError]);
  assert.equal(error.kind, "invalid_input");
  assert.match(error.message, /send_template/);
  assert.equal(calls.length, 1);
});

test("an invalid token surfaces as auth_error", async () => {
  const tokenError = { status: 401, body: { error: { code: 190, type: "OAuthException", message: "Invalid OAuth access token" } } };
  await rejectsWithKind(assert, runWithResponses("list_phone_numbers", {}, [tokenError]), "auth_error", /Invalid OAuth/);
});

test("a send that hits a 5xx is not retried and says the outcome is unknown", async () => {
  const serverError = { status: 500, body: { error: { code: 131000, message: "Something went wrong" } } };
  const { error, calls } = await runExpectingFailure("send_text", { to: "6281234567890", body: "hi" }, [serverError, { body: {} }]);
  assert.equal(error.kind, "api_error");
  assert.match(error.message, /outcome unknown/);
  assert.equal(calls.length, 1);
});

test("a send hitting the pair rate limit 131056 is not retried", async () => {
  const pairLimit = { status: 400, body: { error: { code: 131056, message: "pair rate limit" } } };
  const { error, calls } = await runExpectingFailure("send_text", { to: "6281234567890", body: "hi" }, [pairLimit, { body: {} }]);
  assert.equal(error.kind, "rate_limited");
  assert.equal(calls.length, 1);
});

for (const [rawNumber, expectedDigits] of [
  ["6281234567890", "6281234567890"],
  ["+62 812-3456-7890", "6281234567890"],
  ["+1 (650) 555-1234", "16505551234"],
]) {
  test(`normalizePhoneNumber("${rawNumber}") gives ${expectedDigits}`, () => {
    assert.equal(normalizePhoneNumber(rawNumber, "to"), expectedDigits);
  });
}

for (const invalidNumber of ["081234567890", "12345", "+1234567890123456", "62abc1234567", "++6281234567"]) {
  test(`normalizePhoneNumber rejects "${invalidNumber}"`, () => {
    assert.throws(() => normalizePhoneNumber(invalidNumber, "to"), (error) => error.kind === "invalid_input" && /E\.164/.test(error.message));
  });
}
