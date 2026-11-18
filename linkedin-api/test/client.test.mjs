import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeRestliValue, parseLinkedInError } from "../lib/client.mjs";
import { runWithResponses } from "./helpers.mjs";

for (const [label, status, body, expectedKind] of [
  ["an invalid token", 401, { status: 401, serviceErrorCode: 65600, code: "INVALID_ACCESS_TOKEN", message: "Invalid access token" }, "auth_error"],
  ["an expired token", 401, { status: 401, serviceErrorCode: 65602, message: "The token used in the request has expired" }, "auth_error"],
  ["a missing permission", 403, { status: 403, serviceErrorCode: 100, code: "ACCESS_DENIED", message: "Not enough permissions" }, "permission_denied"],
  ["a throttled app", 429, { status: 429, serviceErrorCode: 101, message: "Resource level throttle limit reached" }, "rate_limited"],
  ["an inactive version", 426, { status: 426, code: "NONEXISTENT_VERSION", message: "Requested version 20200101 is not active" }, "invalid_input"],
  ["a validation failure", 422, { status: 422, message: "ERROR :: /commentary :: is required" }, "invalid_input"],
]) {
  test(`parseLinkedInError maps ${label} to ${expectedKind}`, () => {
    assert.equal(parseLinkedInError(status, body).kind, expectedKind);
  });
}

test("parseLinkedInError includes the service error code and code in the message", () => {
  const parsed = parseLinkedInError(403, { status: 403, serviceErrorCode: 100, code: "ACCESS_DENIED", message: "Not enough permissions" });
  assert.match(parsed.message, /Not enough permissions/);
  assert.match(parsed.message, /serviceErrorCode 100/);
  assert.match(parsed.message, /ACCESS_DENIED/);
});

test("parseLinkedInError adds a LINKEDIN_VERSION hint for NONEXISTENT_VERSION", () => {
  const parsed = parseLinkedInError(426, { status: 426, code: "NONEXISTENT_VERSION", message: "Requested version 20200101 is not active" });
  assert.match(parsed.message, /LINKEDIN_VERSION/);
});

test("parseLinkedInError leaves non-LinkedIn bodies to the default mapping", () => {
  assert.deepEqual(parseLinkedInError(502, { text: "Bad gateway" }), {});
});

test("encodeRestliValue escapes URN reserved characters", () => {
  assert.equal(encodeRestliValue("urn:li:comment:(urn:li:activity:1,2)"), "urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A1%2C2%29");
  assert.equal(encodeRestliValue("urn:li:share:1"), "urn%3Ali%3Ashare%3A1");
});

test("an HTTP 401 becomes auth_error and never echoes the token", async () => {
  await assert.rejects(
    runWithResponses("get_post", { post_urn: "urn:li:share:1" }, [
      { status: 401, body: { status: 401, serviceErrorCode: 65600, message: "Invalid access token li-token" } },
    ]),
    (error) => error.kind === "auth_error" && !error.message.includes("li-token") && /65600/.test(error.message),
  );
});

test("an HTTP 404 becomes not_found", async () => {
  await assert.rejects(
    runWithResponses("get_post", { post_urn: "urn:li:share:1" }, [{ status: 404, body: { status: 404, message: "Not Found" } }]),
    (error) => error.kind === "not_found",
  );
});
