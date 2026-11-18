import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithResponses } from "./helpers.mjs";

const BASE_PATH = "/v1.0";
const PROFILE_FIELDS = "id,username,name,threads_profile_picture_url,threads_biography,is_verified";

// Each case: operation + args → expected single request (method, path, and a subset of query/form).
const REQUEST_CASES = [
  ["get_profile", {}, { method: "GET", path: "/me", query: { fields: PROFILE_FIELDS } }],
  ["lookup_profile", { username: "zuck" }, { method: "GET", path: "/profile_lookup", query: { username: "zuck" } }],
  ["list_threads", { limit: 5, cursor: "c1", since: "2026-01-01" }, { method: "GET", path: "/me/threads", query: { limit: "5", after: "c1", since: "2026-01-01" } }],
  ["list_threads", { user_id: "42" }, { method: "GET", path: "/42/threads", query: { limit: "25" } }],
  ["list_my_replies", { limit: 3 }, { method: "GET", path: "/me/replies", query: { limit: "3" } }],
  ["list_mentions", {}, { method: "GET", path: "/me/mentions", query: { limit: "25" } }],
  [
    "keyword_search",
    { q: "graphrt", search_type: "RECENT", search_mode: "TAG" },
    { method: "GET", path: "/keyword_search", query: { q: "graphrt", search_type: "RECENT", search_mode: "TAG", limit: "25" } },
  ],
  ["repost_thread", { media_id: "m1" }, { method: "POST", path: "/m1/repost" }],
  ["delete_thread", { media_id: "m1" }, { method: "DELETE", path: "/m1" }],
  ["list_replies", { media_id: "m1" }, { method: "GET", path: "/m1/replies", query: { reverse: "false" } }],
  ["list_replies", { media_id: "m1", conversation: true, reverse: true }, { method: "GET", path: "/m1/conversation", query: { reverse: "true" } }],
  ["hide_reply", { reply_id: "r1", hidden: true }, { method: "POST", path: "/r1/manage_reply", form: { hide: "true" } }],
  ["hide_reply", { reply_id: "r1", hidden: false }, { method: "POST", path: "/r1/manage_reply", form: { hide: "false" } }],
  ["list_pending_replies", { media_id: "m1", approval_status: "ignored" }, { method: "GET", path: "/m1/pending_replies", query: { approval_status: "ignored" } }],
  ["approve_pending_reply", { reply_id: "r1", approve: true }, { method: "POST", path: "/r1/manage_pending_reply", form: { approve: "true" } }],
  ["approve_pending_reply", { reply_id: "r1", approve: false }, { method: "POST", path: "/r1/manage_pending_reply", form: { approve: "false" } }],
  [
    "get_publishing_limit",
    {},
    { method: "GET", path: "/me/threads_publishing_limit", query: { fields: "quota_usage,config,reply_quota_usage,reply_config,delete_quota_usage,delete_config" } },
  ],
  ["api_request", { method: "GET", path: "/me/threads", query: { limit: 2 } }, { method: "GET", path: "/me/threads", query: { limit: "2" } }],
];

for (const [operationName, args, expectedRequest] of REQUEST_CASES) {
  test(`${operationName} ${JSON.stringify(args)} sends ${expectedRequest.method} ${expectedRequest.path}`, async () => {
    const { calls } = await runWithResponses(operationName, args);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, expectedRequest.method);
    assert.equal(call.path, BASE_PATH + expectedRequest.path);
    assert.equal(call.headers.authorization, "Bearer threads-token");
    assert.equal(call.query.access_token, undefined);
    for (const [field, expectedSubset] of Object.entries({ query: expectedRequest.query, form: expectedRequest.form })) {
      for (const [key, expectedValue] of Object.entries(expectedSubset ?? {})) assert.equal(call[field]?.[key], expectedValue, `${field}.${key}`);
    }
  });
}

test("list operations map data and next_cursor", async () => {
  const withNext = await runWithResponses("list_threads", {}, [{ body: { data: [{ id: "t1" }], paging: { cursors: { after: "A" }, next: "https://graph.threads.net/next" } } }]);
  assert.deepEqual(withNext.output, { data: [{ id: "t1" }], next_cursor: "A" });
  const lastPage = await runWithResponses("list_replies", { media_id: "m1" }, [{ body: { data: [], paging: { cursors: { after: "B" } } } }]);
  assert.deepEqual(lastPage.output, { data: [], next_cursor: null });
});

test("keyword_search requires q", async () => {
  await assert.rejects(runWithResponses("keyword_search", {}, []), (error) => error.kind === "invalid_input");
});

test("refresh_access_token sends the current token as a query param and returns the new token data", async () => {
  const refreshed = { access_token: "new-token", token_type: "bearer", expires_in: 5183944 };
  const { output, calls } = await runWithResponses("refresh_access_token", {}, [{ body: refreshed }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].path, "/refresh_access_token");
  assert.equal(calls[0].query.grant_type, "th_refresh_token");
  assert.equal(calls[0].query.access_token, "threads-token");
  assert.equal(calls[0].headers.authorization, undefined);
  assert.deepEqual(output.data, refreshed);
});

test("refresh_access_token maps an expired token error to auth_error", async () => {
  await assert.rejects(
    runWithResponses("refresh_access_token", {}, [{ status: 400, body: { error: { code: 190, message: "Session has expired" } } }]),
    (error) => error.kind === "auth_error",
  );
});

test("operations fail with auth_error when THREADS_ACCESS_TOKEN is missing", async () => {
  await assert.rejects(runWithResponses("get_profile", {}, [], { GRAPHRT_POLL_INTERVAL_MS: "0" }), (error) => error.kind === "auth_error");
});
