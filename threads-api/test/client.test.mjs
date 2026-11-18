import { test } from "node:test";
import assert from "node:assert/strict";
import { parseThreadsError, toPage } from "../lib/client.mjs";
import { runWithResponses } from "./helpers.mjs";

for (const [code, expectedKind] of [
  [4, "rate_limited"],
  [17, "rate_limited"],
  [32, "rate_limited"],
  [613, "rate_limited"],
  [190, "auth_error"],
  [102, "auth_error"],
  [10, "permission_denied"],
  [200, "permission_denied"],
  [299, "permission_denied"],
  [100, "invalid_input"],
  [24, "not_found"],
]) {
  test(`parseThreadsError maps code ${code} to ${expectedKind}`, () => {
    assert.equal(parseThreadsError(400, { error: { code, message: "m" } }).kind, expectedKind);
  });
}

test("parseThreadsError maps an OAuthException without a known code on 401 to auth_error", () => {
  assert.equal(parseThreadsError(401, { error: { type: "OAuthException", message: "bad" } }).kind, "auth_error");
});

test("parseThreadsError leaves unknown codes to the HTTP status mapping", () => {
  assert.equal(parseThreadsError(500, { error: { code: 1, message: "unknown" } }).kind, undefined);
});

test("parseThreadsError includes the user message, code, subcode and trace id", () => {
  const parsed = parseThreadsError(400, {
    error: { code: 100, error_subcode: 2207051, message: "Invalid parameter", error_user_msg: "Text too long", fbtrace_id: "TRACE" },
  });
  assert.match(parsed.message, /Text too long/);
  assert.match(parsed.message, /code 100/);
  assert.match(parsed.message, /subcode 2207051/);
  assert.match(parsed.message, /TRACE/);
});

test("parseThreadsError leaves non-Graph bodies to the default mapping", () => {
  assert.deepEqual(parseThreadsError(502, { text: "Bad gateway" }), {});
});

test("an HTTP 400 with Graph code 190 becomes auth_error without leaking the token", async () => {
  await assert.rejects(
    runWithResponses("get_profile", {}, [{ status: 400, body: { error: { code: 190, type: "OAuthException", message: "Invalid token threads-token" } } }]),
    (error) => error.kind === "auth_error" && !error.message.includes("threads-token"),
  );
});

test("an HTTP 400 with Graph code 4 is rate_limited", async () => {
  // Rate limits are retried; the three canned responses cover the first attempt and both retries.
  const rateLimited = { status: 400, body: { error: { code: 4, message: "Application request limit reached" } }, headers: { "retry-after": "0" } };
  await assert.rejects(runWithResponses("get_profile", {}, [rateLimited, rateLimited, rateLimited]), (error) => error.kind === "rate_limited");
});

test("toPage returns the after cursor only when paging.next exists", () => {
  assert.deepEqual(toPage({ data: [1], paging: { cursors: { after: "A" }, next: "https://graph.threads.net/n" } }), { data: [1], next_cursor: "A" });
  assert.deepEqual(toPage({ data: [1], paging: { cursors: { after: "A" } } }), { data: [1], next_cursor: null });
  assert.deepEqual(toPage({}), { data: [], next_cursor: null });
});

test("a caller-supplied access_token query param is dropped; the env token is sent as Bearer", async () => {
  const { calls } = await runWithResponses("api_request", { path: "/me", query: { access_token: "attacker-token", fields: "id" } });
  assert.equal(calls[0].query.access_token, undefined);
  assert.equal(calls[0].query.fields, "id");
  assert.equal(calls[0].headers.authorization, "Bearer threads-token");
});

test("api_request refuses other origins", async () => {
  await assert.rejects(runWithResponses("api_request", { path: "https://evil.test/me" }, []), (error) => error.kind === "invalid_input");
});
