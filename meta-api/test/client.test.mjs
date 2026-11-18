import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMetaError } from "../lib/client.mjs";

const noHeaders = new Headers();

for (const [code, expectedKind] of [
  [4, "rate_limited"],
  [17, "rate_limited"],
  [32, "rate_limited"],
  [613, "rate_limited"],
  [80001, "rate_limited"],
  [190, "auth_error"],
  [102, "auth_error"],
  [10, "permission_denied"],
  [200, "permission_denied"],
  [299, "permission_denied"],
  [100, "invalid_input"],
  [506, "invalid_input"],
]) {
  test(`parseMetaError maps code ${code} to ${expectedKind}`, () => {
    const parsed = parseMetaError(400, { error: { code, message: "m" } }, noHeaders);
    assert.equal(parsed.kind, expectedKind);
  });
}

test("parseMetaError prefers the user-facing message and adds codes and trace id", () => {
  const parsed = parseMetaError(
    400,
    { error: { code: 100, error_subcode: 33, message: "Unsupported get request", error_user_msg: "Object missing", fbtrace_id: "TRACE" } },
    noHeaders,
  );
  assert.match(parsed.message, /Object missing/);
  assert.match(parsed.message, /code 100/);
  assert.match(parsed.message, /subcode 33/);
  assert.match(parsed.message, /TRACE/);
});

test("parseMetaError reads the regain-access estimate from X-Business-Use-Case-Usage", () => {
  const usageHeader = JSON.stringify({ 111: [{ type: "pages", call_count: 100, estimated_time_to_regain_access: 3 }] });
  const parsed = parseMetaError(400, { error: { code: 80001, message: "too many" } }, new Headers({ "x-business-use-case-usage": usageHeader }));
  assert.equal(parsed.retryAfterMs, 180000);
});

test("parseMetaError leaves non-Graph bodies to the default mapping", () => {
  assert.deepEqual(parseMetaError(502, { text: "Bad gateway" }, noHeaders), {});
});

test("parseMetaError maps code 100 subcode 33 (object does not exist) to not_found", () => {
  assert.equal(parseMetaError(400, { error: { code: 100, error_subcode: 33, message: "m" } }, noHeaders).kind, "not_found");
});

test("parseMetaError omits the code when Graph sends none", () => {
  const parsed = parseMetaError(400, { error: { message: "Something odd" } }, noHeaders);
  assert.equal(parsed.message.includes("NaN"), false);
  assert.match(parsed.message, /Something odd/);
});
