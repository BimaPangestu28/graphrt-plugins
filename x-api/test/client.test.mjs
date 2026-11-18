import { test } from "node:test";
import assert from "node:assert/strict";
import { detectXBodyError, parseXError, toPage } from "../lib/client.mjs";
import { runWithResponses, rejectsWithKind } from "./helpers.mjs";

const noHeaders = new Headers();
const problem = (problemName, extra = {}) => ({ type: `https://api.x.com/2/problems/${problemName}`, title: "T", detail: `detail of ${problemName}`, ...extra });

for (const [status, problemName, expectedKind] of [
  [429, "usage-capped", "rate_limited"],
  [400, "invalid-request", "invalid_input"],
  [404, "resource-not-found", "not_found"],
  [403, "not-authorized-for-resource", "permission_denied"],
  [403, "client-forbidden", "permission_denied"],
  [403, "unsupported-authentication", "auth_error"],
  [403, "dm-rate-limited", "rate_limited"],
  [403, "dm-recipient-cannot-receive", "permission_denied"],
]) {
  test(`parseXError maps ${problemName} (${status}) to ${expectedKind}`, () => {
    const parsed = parseXError(status, problem(problemName), noHeaders);
    assert.equal(parsed.kind, expectedKind);
    assert.match(parsed.message, new RegExp(`detail of ${problemName}`));
  });
}

test("parseXError also reads the problem type from twitter.com URIs and errors[]", () => {
  const legacyHost = parseXError(429, { type: "https://api.twitter.com/2/problems/usage-capped", title: "Usage capped" }, noHeaders);
  assert.equal(legacyHost.kind, "rate_limited");
  const errorList = parseXError(400, { errors: [{ ...problem("invalid-request"), message: "bad query" }], title: "Invalid Request" }, noHeaders);
  assert.equal(errorList.kind, "invalid_input");
  assert.match(errorList.message, /bad query/);
});

test("parseXError maps legacy numeric codes", () => {
  assert.equal(parseXError(429, { errors: [{ code: 88, message: "Rate limit exceeded" }] }, noHeaders).kind, "rate_limited");
  assert.equal(parseXError(401, { errors: [{ code: 89, message: "Invalid or expired token" }] }, noHeaders).kind, "auth_error");
});

test("parseXError maps plain 401 and 429 bodies", () => {
  assert.equal(parseXError(401, { title: "Unauthorized", type: "about:blank", status: 401, detail: "Unauthorized" }, noHeaders).kind, "auth_error");
  assert.equal(parseXError(429, { title: "Too Many Requests", detail: "Too Many Requests" }, noHeaders).kind, "rate_limited");
});

test("parseXError turns x-rate-limit-reset (unix seconds) into retryAfterMs", () => {
  const resetInSeconds = Math.floor(Date.now() / 1000) + 30;
  const parsed = parseXError(429, { title: "Too Many Requests" }, new Headers({ "x-rate-limit-reset": String(resetInSeconds) }));
  assert.ok(parsed.retryAfterMs > 25000 && parsed.retryAfterMs <= 30000, `got ${parsed.retryAfterMs}`);
  const pastReset = parseXError(429, {}, new Headers({ "x-rate-limit-reset": "1" }));
  assert.equal(pastReset.retryAfterMs, 0);
});

test("parseXError leaves non-X bodies to the default mapping", () => {
  assert.deepEqual(parseXError(502, { text: "Bad gateway" }, noHeaders), {});
});

test("detectXBodyError flags 200 bodies with errors but no data", () => {
  const detected = detectXBodyError({ errors: [{ ...problem("resource-not-found"), detail: "Could not find tweet with id: [1]." }] }, noHeaders);
  assert.equal(detected.kind, "not_found");
  assert.match(detected.message, /Could not find tweet/);
});

test("detectXBodyError accepts bodies with data, with or without partial errors", () => {
  assert.equal(detectXBodyError({ data: { id: "1" }, errors: [problem("resource-not-found")] }, noHeaders), null);
  assert.equal(detectXBodyError({ data: [] }, noHeaders), null);
  assert.equal(detectXBodyError({ meta: { result_count: 0 } }, noHeaders), null);
});

test("a 200 errors-only response becomes a PluginError", async () => {
  await rejectsWithKind(assert, runWithResponses("get_post", { post_id: "1" }, [{ body: { errors: [problem("resource-not-found")] } }]), "not_found");
});

test("a 200 response with data and errors is returned with the partial errors", async () => {
  const body = { data: [{ id: "1" }], errors: [problem("resource-not-found")] };
  const { output } = await runWithResponses("search_recent_posts", { query: "x" }, [{ body }]);
  assert.deepEqual(output.data.errors, body.errors);
  assert.deepEqual(output.data.data, [{ id: "1" }]);
});

test("auth errors from the API keep their kind and never contain the token", async () => {
  await assert.rejects(
    runWithResponses("get_me", {}, [{ status: 401, body: { title: "Unauthorized", detail: "Bad token user-token" } }]),
    (error) => error.kind === "auth_error" && !error.message.includes("user-token"),
  );
});

test("toPage maps meta.next_token to next_cursor", () => {
  assert.deepEqual(toPage({ data: [{ id: "1" }], meta: { next_token: "N" } }).next_cursor, "N");
  assert.equal(toPage({ data: [], meta: { result_count: 0 } }).next_cursor, null);
});
