import { test } from "node:test";
import assert from "node:assert/strict";
import { BUSINESS_PATH_PREFIX, businessOk, openOk, runWithResponses } from "./helpers.mjs";

// Each case: operation + args → expected single request (method, path, and a subset of query/json).
const OPEN_API_CASES = [
  ["get_user_info", {}, { method: "GET", path: "/v2/user/info/", queryIncludes: { fields: /open_id,.*display_name/ } }],
  ["get_user_info", { fields: "open_id" }, { method: "GET", path: "/v2/user/info/", query: { fields: "open_id" } }],
  ["list_videos", { limit: 5, cursor: "1700000000000" }, { method: "POST", path: "/v2/video/list/", json: { cursor: 1700000000000, max_count: 5 } }],
  ["list_videos", {}, { method: "POST", path: "/v2/video/list/", json: { max_count: 20 }, queryIncludes: { fields: /id,.*title/ } }],
  ["query_videos", { video_ids: ["v1", "v2"] }, { method: "POST", path: "/v2/video/query/", json: { filters: { video_ids: ["v1", "v2"] } } }],
  ["get_creator_info", {}, { method: "POST", path: "/v2/post/publish/creator_info/query/" }],
  ["get_publish_status", { publish_id: "p1" }, { method: "POST", path: "/v2/post/publish/status/fetch/", json: { publish_id: "p1" } }],
  ["api_request", { path: "/v2/user/info/", query: { fields: "open_id" } }, { method: "GET", path: "/v2/user/info/", query: { fields: "open_id" } }],
];

for (const [operationName, args, expectedRequest] of OPEN_API_CASES) {
  test(`${operationName} ${JSON.stringify(args)} sends ${expectedRequest.method} ${expectedRequest.path} to the Open API`, async () => {
    const { calls } = await runWithResponses(operationName, args, [openOk()]);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, expectedRequest.method);
    assert.equal(new URL(call.url).origin, "https://open.tiktokapis.com");
    assert.equal(call.path, expectedRequest.path);
    assert.equal(call.headers.authorization, "Bearer open-token");
    assert.equal(call.headers["access-token"], undefined);
    for (const [key, expectedValue] of Object.entries(expectedRequest.query ?? {})) assert.equal(call.query[key], expectedValue, `query.${key}`);
    for (const [key, pattern] of Object.entries(expectedRequest.queryIncludes ?? {})) assert.match(call.query[key], pattern, `query.${key}`);
    if (expectedRequest.json) assert.deepEqual(call.json, expectedRequest.json);
  });
}

const BUSINESS_API_CASES = [
  [
    "list_comments",
    { video_id: "v1", limit: 10, cursor: "20" },
    { method: "GET", path: "/business/comment/list/", query: { business_id: "biz-1", video_id: "v1", max_count: "10", cursor: "20", status: "PUBLIC" } },
  ],
  [
    "list_comment_replies",
    { video_id: "v1", comment_id: "c1" },
    { method: "GET", path: "/business/comment/reply/list/", query: { business_id: "biz-1", video_id: "v1", comment_id: "c1" } },
  ],
  ["create_comment", { video_id: "v1", text: "hi" }, { method: "POST", path: "/business/comment/create/", json: { business_id: "biz-1", video_id: "v1", text: "hi" } }],
  [
    "reply_to_comment",
    { video_id: "v1", comment_id: "c1", text: "thanks" },
    { method: "POST", path: "/business/comment/reply/create/", json: { business_id: "biz-1", video_id: "v1", comment_id: "c1", text: "thanks" } },
  ],
  ["set_comment_hidden", { comment_id: "c1", hidden: true }, { method: "POST", path: "/business/comment/hide/", json: { business_id: "biz-1", comment_id: "c1", action: "HIDE" } }],
  [
    "set_comment_hidden",
    { comment_id: "c1", hidden: false, video_id: "v1" },
    { method: "POST", path: "/business/comment/hide/", json: { business_id: "biz-1", comment_id: "c1", video_id: "v1", action: "UNHIDE" } },
  ],
  ["set_comment_liked", { comment_id: "c1", liked: false }, { method: "POST", path: "/business/comment/like/", json: { business_id: "biz-1", comment_id: "c1", action: "UNLIKE" } }],
  ["delete_comment", { comment_id: "c1", business_id: "biz-2" }, { method: "POST", path: "/business/comment/delete/", json: { business_id: "biz-2", comment_id: "c1" } }],
  [
    "list_conversations",
    { limit: 5 },
    { method: "GET", path: "/business/message/conversation/list/", query: { business_id: "biz-1", conversation_type: "SINGLE", limit: "5" } },
  ],
  [
    "list_messages",
    { conversation_id: "conv1", cursor: "x" },
    { method: "GET", path: "/business/message/content/list/", query: { business_id: "biz-1", conversation_id: "conv1", conversation_type: "SINGLE", cursor: "x" } },
  ],
  [
    "send_message",
    { recipient: "conv1", text: "halo" },
    {
      method: "POST",
      path: "/business/message/send/",
      json: { business_id: "biz-1", recipient_type: "CONVERSATION", recipient: "conv1", message_type: "TEXT", text: { body: "halo" } },
    },
  ],
  ["api_request", { api: "business", path: "/business/get/", query: { business_id: "biz-1" } }, { method: "GET", path: "/business/get/", query: { business_id: "biz-1" } }],
];

for (const [operationName, args, expectedRequest] of BUSINESS_API_CASES) {
  test(`${operationName} ${JSON.stringify(args)} sends ${expectedRequest.method} ${expectedRequest.path} to the Business API`, async () => {
    const { calls } = await runWithResponses(operationName, args, [businessOk()]);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, expectedRequest.method);
    assert.equal(new URL(call.url).origin, "https://business-api.tiktok.com");
    assert.equal(call.path, BUSINESS_PATH_PREFIX + expectedRequest.path);
    assert.equal(call.headers["access-token"], "business-token");
    assert.equal(call.headers.authorization, undefined);
    for (const [key, expectedValue] of Object.entries(expectedRequest.query ?? {})) assert.equal(call.query[key], expectedValue, `query.${key}`);
    if (expectedRequest.json) assert.deepEqual(call.json, expectedRequest.json);
  });
}

test("list_videos maps cursor/has_more to next_cursor", async () => {
  const withMore = await runWithResponses("list_videos", {}, [openOk({ videos: [{ id: "v1" }], cursor: 1699999999000, has_more: true })]);
  assert.deepEqual(withMore.output, { data: [{ id: "v1" }], next_cursor: "1699999999000" });
  const lastPage = await runWithResponses("list_videos", {}, [openOk({ videos: [], cursor: 0, has_more: false })]);
  assert.deepEqual(lastPage.output, { data: [], next_cursor: null });
});

test("list_comments maps cursor/has_more to next_cursor and returns the comments", async () => {
  const withMore = await runWithResponses("list_comments", { video_id: "v1" }, [businessOk({ comments: [{ comment_id: "c1" }], cursor: 20, has_more: true })]);
  assert.deepEqual(withMore.output, { data: [{ comment_id: "c1" }], next_cursor: "20" });
  const lastPage = await runWithResponses("list_comments", { video_id: "v1" }, [businessOk({ comments: [], cursor: 40, has_more: false })]);
  assert.deepEqual(lastPage.output, { data: [], next_cursor: null });
});

test("a Business list whose data has no list key and only paging fields returns an empty array", async () => {
  for (const payload of [{}, { has_more: false, cursor: 0 }, { total: 0 }, null]) {
    const { output } = await runWithResponses("list_conversations", {}, [businessOk(payload)]);
    assert.deepEqual(output, { data: [], next_cursor: null }, JSON.stringify(payload));
  }
});

test("a Business list whose data holds other fields but not the list key fails with api_error naming the keys", async () => {
  await assert.rejects(
    runWithResponses("list_conversations", {}, [businessOk({ items: [1], has_more: false })]),
    (error) => error.kind === "api_error" && /`conversations`/.test(error.message) && /items/.test(error.message) && /api_request/.test(error.message),
  );
});

test("get_user_info returns data.user", async () => {
  const { output } = await runWithResponses("get_user_info", {}, [openOk({ user: { open_id: "o1" } })]);
  assert.deepEqual(output.data, { open_id: "o1" });
});

test("list_videos rejects a limit above 20", async () => {
  await assert.rejects(runWithResponses("list_videos", { limit: 21 }), (error) => error.kind === "invalid_input");
});

test("list_videos rejects a non-numeric cursor", async () => {
  await assert.rejects(runWithResponses("list_videos", { cursor: "abc" }), (error) => error.kind === "invalid_input");
});

test("query_videos rejects an empty or too long video_ids list", async () => {
  await assert.rejects(runWithResponses("query_videos", { video_ids: [] }), (error) => error.kind === "invalid_input");
  const tooMany = Array.from({ length: 21 }, (_, index) => `v${index}`);
  await assert.rejects(runWithResponses("query_videos", { video_ids: tooMany }), (error) => error.kind === "invalid_input");
});

test("api_request rejects an unknown api selector", async () => {
  await assert.rejects(runWithResponses("api_request", { api: "ads", path: "/x" }), (error) => error.kind === "invalid_input");
});

test("a node access_token on a Business operation is rejected instead of silently ignored", async () => {
  const { businessOk: ok, runWithResponses: run, TEST_ENVIRONMENT: environment } = await import("./helpers.mjs");
  await assert.rejects(
    run("list_comments", { video_id: "v1", access_token: "account-b-token" }, [ok({ comments: [] })], environment, "node"),
    (error) => error.kind === "invalid_input" && /TIKTOK_BUSINESS_ACCESS_TOKEN/.test(error.message),
  );
});

test("the Business token is redacted from api_request responses and error messages", async () => {
  const { businessOk: ok, runWithResponses: run } = await import("./helpers.mjs");
  const { output } = await run("api_request", { api: "business", path: "/business/get/", query: { business_id: "biz-1" } }, [ok({ echo: "token=business-token" })]);
  assert.equal(JSON.stringify(output).includes("business-token"), false);
  await assert.rejects(
    run("api_request", { api: "business", path: "/business/get/" }, [{ status: 502, body: { text: "upstream saw business-token" } }, { status: 502, body: {} }, { status: 502, body: {} }]),
    (error) => !error.message.includes("business-token"),
  );
});

test("refresh_access_token is a node but not an LLM tool", async () => {
  const { buildDescriptors } = await import("../lib/shared/operations.mjs");
  const { pluginDefinition } = await import("../definition.mjs");
  const { nodes, tools } = buildDescriptors(pluginDefinition);
  assert.ok(nodes.some((node) => node.kind === "tiktok-api.refresh_access_token"));
  assert.equal(tools.some((tool) => tool.name === "refresh_access_token"), false);
});

const OPEN_SERVER_ERROR = { status: 503, body: { error: { code: "internal_error", message: "try again", log_id: "L9" } } };

for (const [operationName, args] of [
  ["list_videos", {}],
  ["query_videos", { video_ids: ["v1"] }],
  ["get_creator_info", {}],
  ["get_publish_status", { publish_id: "p1" }],
]) {
  test(`${operationName} is a POST read: a 5xx is retried, not reported as a write with unknown outcome`, async () => {
    const { calls } = await runWithResponses(operationName, args, [OPEN_SERVER_ERROR, openOk({ videos: [] })]);
    assert.equal(calls.length, 2);
  });
}

test("business_id is trimmed, from the arguments and from TIKTOK_BUSINESS_ID", async () => {
  const fromArgs = await runWithResponses("list_comments", { video_id: "v1", business_id: "  biz-9 " }, [businessOk({ comments: [] })]);
  assert.equal(fromArgs.calls[0].query.business_id, "biz-9");
  const { TEST_ENVIRONMENT } = await import("./helpers.mjs");
  const fromEnvironment = await runWithResponses("delete_comment", { comment_id: "c1" }, [businessOk()], { ...TEST_ENVIRONMENT, TIKTOK_BUSINESS_ID: " biz-7\n" });
  assert.equal(fromEnvironment.calls[0].json.business_id, "biz-7");
});

test("a whitespace-only business_id is rejected with invalid_input", async () => {
  const { TEST_ENVIRONMENT } = await import("./helpers.mjs");
  await assert.rejects(runWithResponses("list_comments", { video_id: "v1", business_id: "   " }, []), (error) => error.kind === "invalid_input" && /business_id/.test(error.message));
  await assert.rejects(
    runWithResponses("delete_comment", { comment_id: "c1" }, [], { ...TEST_ENVIRONMENT, TIKTOK_BUSINESS_ID: "  " }),
    (error) => error.kind === "invalid_input" && /TIKTOK_BUSINESS_ID/.test(error.message),
  );
});

test("query_videos accepts a single plain video id string", async () => {
  const { calls } = await runWithResponses("query_videos", { video_ids: " v1 " }, [openOk({ videos: [] })]);
  assert.deepEqual(calls[0].json, { filters: { video_ids: ["v1"] } });
  const fromJson = await runWithResponses("query_videos", { video_ids: '["v1","v2"]' }, [openOk({ videos: [] })]);
  assert.deepEqual(fromJson.calls[0].json.filters.video_ids, ["v1", "v2"]);
});

test("query_videos rejects non-string ids", async () => {
  await assert.rejects(runWithResponses("query_videos", { video_ids: [1, {}] }), (error) => error.kind === "invalid_input" && /video_ids/.test(error.message));
});
