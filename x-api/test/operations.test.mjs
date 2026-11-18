import { test } from "node:test";
import assert from "node:assert/strict";
import { runExpectingFailure, runWithResponses, rejectsWithKind, TEST_ENVIRONMENT } from "./helpers.mjs";

// Each case: operation + args → expected single request (method, path, and a subset of query / exact json).
const REQUEST_CASES = [
  ["get_me", {}, { method: "GET", path: "/2/users/me" }],
  ["get_me", { query_params: { "user.fields": ["public_metrics", "description"] } }, { method: "GET", path: "/2/users/me", query: { "user.fields": "public_metrics,description" } }],
  ["get_user_by_username", { username: "XDevelopers" }, { method: "GET", path: "/2/users/by/username/XDevelopers" }],
  ["create_post", { text: "hello" }, { method: "POST", path: "/2/tweets", json: { text: "hello" } }],
  [
    "create_post",
    { text: "re", reply_to_post_id: "100", media_ids: ["7", "8"], reply_settings: "following" },
    { method: "POST", path: "/2/tweets", json: { text: "re", reply: { in_reply_to_tweet_id: "100" }, media: { media_ids: ["7", "8"] }, reply_settings: "following" } },
  ],
  [
    "create_post",
    { text: "vote", poll_options: ["a", "b"], poll_duration_minutes: 60, quote_post_id: "5" },
    { method: "POST", path: "/2/tweets", json: { text: "vote", quote_tweet_id: "5", poll: { options: ["a", "b"], duration_minutes: 60 } } },
  ],
  ["delete_post", { post_id: "100" }, { method: "DELETE", path: "/2/tweets/100" }],
  ["get_post", { post_id: "100", query_params: { expansions: "author_id" } }, { method: "GET", path: "/2/tweets/100", query: { expansions: "author_id" } }],
  ["list_user_posts", {}, { method: "GET", path: "/2/users/42/tweets", query: { max_results: "10" } }],
  [
    "list_user_posts",
    { user_id: "77", limit: 50, cursor: "P1", exclude: ["replies", "retweets"] },
    { method: "GET", path: "/2/users/77/tweets", query: { max_results: "50", pagination_token: "P1", exclude: "replies,retweets" } },
  ],
  ["list_mentions", { cursor: "M1" }, { method: "GET", path: "/2/users/42/mentions", query: { max_results: "10", pagination_token: "M1" } }],
  [
    "search_recent_posts",
    { query: "from:XDevelopers", limit: 20, cursor: "S1", sort_order: "recency" },
    { method: "GET", path: "/2/tweets/search/recent", query: { query: "from:XDevelopers", max_results: "20", next_token: "S1", sort_order: "recency" } },
  ],
  ["list_replies", { post_id: "100" }, { method: "GET", path: "/2/tweets/search/recent", query: { query: "conversation_id:100", max_results: "10" } }],
  ["hide_reply", { post_id: "101", hidden: true }, { method: "PUT", path: "/2/tweets/101/hidden", json: { hidden: true } }],
  ["like_post", { post_id: "100" }, { method: "POST", path: "/2/users/42/likes", json: { tweet_id: "100" } }],
  ["unlike_post", { post_id: "100" }, { method: "DELETE", path: "/2/users/42/likes/100" }],
  ["repost", { post_id: "100" }, { method: "POST", path: "/2/users/42/retweets", json: { tweet_id: "100" } }],
  ["undo_repost", { post_id: "100" }, { method: "DELETE", path: "/2/users/42/retweets/100" }],
  ["list_dm_events", { limit: 5, event_types: "MessageCreate" }, { method: "GET", path: "/2/dm_events", query: { max_results: "5", event_types: "MessageCreate" } }],
  ["list_dm_conversation_events", { conversation_id: "42-77", cursor: "D1" }, { method: "GET", path: "/2/dm_conversations/42-77/dm_events", query: { pagination_token: "D1" } }],
  ["list_dm_conversation_events", { participant_id: "77" }, { method: "GET", path: "/2/dm_conversations/with/77/dm_events" }],
  ["send_dm", { participant_id: "77", text: "halo" }, { method: "POST", path: "/2/dm_conversations/with/77/messages", json: { text: "halo" } }],
  [
    "send_dm",
    { conversation_id: "1500", text: "hi all", media_id: "9" },
    { method: "POST", path: "/2/dm_conversations/1500/messages", json: { text: "hi all", attachments: [{ media_id: "9" }] } },
  ],
  [
    "create_group_dm",
    { participant_ids: ["77", "78"], text: "welcome" },
    { method: "POST", path: "/2/dm_conversations", json: { conversation_type: "Group", participant_ids: ["77", "78"], message: { text: "welcome" } } },
  ],
  ["api_request", { method: "GET", path: "/2/users/me/followers", query: { max_results: 5 } }, { method: "GET", path: "/2/users/me/followers", query: { max_results: "5" } }],
];

for (const [operationName, args, expectedRequest] of REQUEST_CASES) {
  test(`${operationName} ${JSON.stringify(args)} sends ${expectedRequest.method} ${expectedRequest.path}`, async () => {
    const { calls } = await runWithResponses(operationName, args, [{ body: { data: {} } }]);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, expectedRequest.method);
    assert.equal(call.url.startsWith("https://api.x.com/"), true);
    assert.equal(call.path, expectedRequest.path);
    assert.equal(call.headers.authorization, "Bearer user-token");
    for (const [key, expectedValue] of Object.entries(expectedRequest.query ?? {})) assert.equal(call.query[key], expectedValue, `query.${key}`);
    if (expectedRequest.json) assert.deepEqual(call.json, expectedRequest.json);
  });
}

test("list operations return the X body and next_cursor from meta.next_token", async () => {
  const body = { data: [{ id: "1" }], includes: { users: [] }, meta: { result_count: 1, next_token: "NEXT" } };
  const withNext = await runWithResponses("list_mentions", {}, [{ body }]);
  assert.deepEqual(withNext.output, { data: body, next_cursor: "NEXT" });
  const lastPage = await runWithResponses("list_dm_events", {}, [{ body: { meta: { result_count: 0 } } }]);
  assert.equal(lastPage.output.next_cursor, null);
});

test("query_params are merged without overriding the operation's own parameters", async () => {
  const { calls } = await runWithResponses("search_recent_posts", { query: "cats", query_params: { query: "dogs", "tweet.fields": "created_at" } }, [{ body: {} }]);
  assert.equal(calls[0].query.query, "cats");
  assert.equal(calls[0].query["tweet.fields"], "created_at");
});

test("query_params values must be scalars or arrays", async () => {
  await rejectsWithKind(assert, runWithResponses("get_me", { query_params: { expansions: { nested: true } } }), "invalid_input", /query_params/);
});

test("operations needing the user id resolve it once via /2/users/me when X_USER_ID is missing", async () => {
  const environmentWithoutUser = { X_ACCESS_TOKEN: "user-token" };
  const { calls } = await runWithResponses("like_post", { post_id: "100" }, [{ body: { data: { id: "999" } } }, { body: { data: { liked: true } } }], environmentWithoutUser);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    ["GET /2/users/me", "POST /2/users/999/likes"],
  );
});

test("user id resolution fails clearly when /2/users/me returns no id", async () => {
  await rejectsWithKind(assert, runWithResponses("list_mentions", {}, [{ body: { data: {} } }], { X_ACCESS_TOKEN: "t" }), "api_error", /user id/);
});

test("a malformed X_USER_ID is rejected", async () => {
  await rejectsWithKind(assert, runWithResponses("repost", { post_id: "1" }, [], { ...TEST_ENVIRONMENT, X_USER_ID: "abc" }), "invalid_input", /X_USER_ID/);
});

test("ids used in paths are validated", async () => {
  await rejectsWithKind(assert, runWithResponses("delete_post", { post_id: "../users/me" }), "invalid_input", /post_id/);
  await rejectsWithKind(assert, runWithResponses("get_user_by_username", { username: "bad name" }), "invalid_input", /username/);
  await rejectsWithKind(assert, runWithResponses("list_dm_conversation_events", { conversation_id: "a/b" }), "invalid_input", /conversation_id/);
  await rejectsWithKind(assert, runWithResponses("create_group_dm", { participant_ids: ["1", "x"], text: "t" }), "invalid_input", /participant_ids/);
});

test("create_post requires text or media and validates polls", async () => {
  await rejectsWithKind(assert, runWithResponses("create_post", {}), "invalid_input", /text/);
  await rejectsWithKind(assert, runWithResponses("create_post", { text: "p", poll_options: ["a", "b"] }), "invalid_input", /poll_duration_minutes/);
  await rejectsWithKind(assert, runWithResponses("create_post", { text: "p", poll_duration_minutes: 60 }), "invalid_input", /poll_options/);
  await rejectsWithKind(assert, runWithResponses("create_post", { text: "p", poll_options: ["a"], poll_duration_minutes: 60 }), "invalid_input", /poll_options/);
  await rejectsWithKind(assert, runWithResponses("create_post", { text: "p", media_ids: ["1"], poll_options: ["a", "b"], poll_duration_minutes: 60 }), "invalid_input", /poll/);
  await rejectsWithKind(assert, runWithResponses("create_post", { text: "p", poll_options: ["a", "b"], poll_duration_minutes: 2 }), "invalid_input", /poll_duration_minutes/);
});

test("create_post accepts media without text", async () => {
  const { calls } = await runWithResponses("create_post", { media_ids: ["7"] });
  assert.deepEqual(calls[0].json, { media: { media_ids: ["7"] } });
});

test("list limits follow each endpoint's max_results range", async () => {
  await rejectsWithKind(assert, runWithResponses("search_recent_posts", { query: "q", limit: 5 }), "invalid_input", /limit/);
  await rejectsWithKind(assert, runWithResponses("list_user_posts", { limit: 4 }), "invalid_input", /limit/);
  await rejectsWithKind(assert, runWithResponses("list_dm_events", { limit: 101 }), "invalid_input", /limit/);
});

test("list_dm_conversation_events and send_dm need exactly one conversation target", async () => {
  await rejectsWithKind(assert, runWithResponses("list_dm_conversation_events", {}), "invalid_input", /conversation_id/);
  await rejectsWithKind(assert, runWithResponses("list_dm_conversation_events", { conversation_id: "1", participant_id: "2" }), "invalid_input", /conversation_id/);
  await rejectsWithKind(assert, runWithResponses("send_dm", { text: "t" }), "invalid_input", /participant_id/);
  await rejectsWithKind(assert, runWithResponses("send_dm", { participant_id: "1", conversation_id: "2", text: "t" }), "invalid_input", /participant_id/);
});

test("send_dm and create_group_dm need text or a media id", async () => {
  await rejectsWithKind(assert, runWithResponses("send_dm", { participant_id: "1" }), "invalid_input", /text/);
  await rejectsWithKind(assert, runWithResponses("create_group_dm", { participant_ids: ["1", "2"] }), "invalid_input", /text/);
});

test("create_group_dm needs at least two participants", async () => {
  await rejectsWithKind(assert, runWithResponses("create_group_dm", { participant_ids: ["1"], text: "t" }), "invalid_input", /participant_ids/);
});

test("operations fail with auth_error when X_ACCESS_TOKEN is missing", async () => {
  await rejectsWithKind(assert, runWithResponses("get_me", {}, [], {}), "auth_error", /X_ACCESS_TOKEN/);
});

test("create_post rejects poll options that are empty or over 25 characters", async () => {
  const pollArgs = (pollOptions) => ({ text: "p", poll_options: pollOptions, poll_duration_minutes: 60 });
  await rejectsWithKind(assert, runWithResponses("create_post", pollArgs(["a", "x".repeat(26)])), "invalid_input", /1-25 characters/);
  await rejectsWithKind(assert, runWithResponses("create_post", pollArgs(["a", "  "])), "invalid_input", /1-25 characters/);
  const { calls } = await runWithResponses("create_post", pollArgs(["a", "x".repeat(25)]));
  assert.deepEqual(calls[0].json.poll.options, ["a", "x".repeat(25)]);
});

test("a non-numeric user id from /2/users/me is never put in a path", async () => {
  const { error, calls } = await runExpectingFailure("like_post", { post_id: "100" }, [{ body: { data: { id: "../tweets/1" } } }, { body: {} }], { X_ACCESS_TOKEN: "t" });
  assert.equal(error.kind, "api_error");
  assert.match(error.message, /user id/);
  assert.equal(calls.length, 1);
});

test("create_group_dm accepts numeric participant ids", async () => {
  const { calls } = await runWithResponses("create_group_dm", { participant_ids: [123, 456], text: "t" });
  assert.deepEqual(calls[0].json.participant_ids, ["123", "456"]);
});
