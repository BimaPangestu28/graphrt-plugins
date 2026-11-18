import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithResponses, TEST_ENVIRONMENT } from "./helpers.mjs";

const BASE_PATH = "/v26.0";

// Each case: operation + args → expected single request (method, path, and a subset of query/form/json).
const REQUEST_CASES = [
  ["get_page", {}, { method: "GET", path: "/111", query: { fields: "id,name,about,category,followers_count,link,picture,instagram_business_account" } }],
  ["get_page", { page_id: "999", fields: "id" }, { method: "GET", path: "/999", query: { fields: "id" } }],
  ["list_page_posts", { limit: 5, cursor: "c1" }, { method: "GET", path: "/111/feed", query: { limit: "5", after: "c1" } }],
  ["create_page_post", { message: "hi", link: "https://x.test" }, { method: "POST", path: "/111/feed", form: { message: "hi", link: "https://x.test", published: "true" } }],
  ["create_page_post", { message: "later", scheduled_publish_time: 1900000000 }, { method: "POST", path: "/111/feed", form: { published: "false", scheduled_publish_time: "1900000000" } }],
  ["create_page_photo_post", { image_url: "https://img.test/a.jpg", message: "pic" }, { method: "POST", path: "/111/photos", form: { url: "https://img.test/a.jpg", message: "pic" } }],
  ["update_page_post", { post_id: "111_5", message: "edited" }, { method: "POST", path: "/111_5", form: { message: "edited" } }],
  ["delete_page_post", { post_id: "111_5" }, { method: "DELETE", path: "/111_5" }],
  ["list_comments", { object_id: "111_5" }, { method: "GET", path: "/111_5/comments", query: { filter: "toplevel", summary: "true", limit: "25" } }],
  ["reply_to_comment", { object_id: "c9", message: "thanks!" }, { method: "POST", path: "/c9/comments", form: { message: "thanks!" } }],
  ["set_comment_hidden", { comment_id: "c9", hidden: true }, { method: "POST", path: "/c9", form: { is_hidden: "true" } }],
  ["delete_comment", { comment_id: "c9" }, { method: "DELETE", path: "/c9" }],
  ["like_comment", { comment_id: "c9" }, { method: "POST", path: "/c9/likes" }],
  ["unlike_comment", { comment_id: "c9" }, { method: "DELETE", path: "/c9/likes" }],
  ["get_instagram_account", {}, { method: "GET", path: "/222" }],
  ["list_instagram_media", { limit: 10 }, { method: "GET", path: "/222/media", query: { limit: "10" } }],
  ["get_instagram_publishing_limit", {}, { method: "GET", path: "/222/content_publishing_limit", query: { fields: "config,quota_usage" } }],
  ["list_instagram_comments", { media_id: "m1" }, { method: "GET", path: "/m1/comments" }],
  ["list_instagram_comment_replies", { comment_id: "ic1" }, { method: "GET", path: "/ic1/replies" }],
  ["reply_to_instagram_comment", { comment_id: "ic1", message: "hey" }, { method: "POST", path: "/ic1/replies", form: { message: "hey" } }],
  ["set_instagram_comment_hidden", { comment_id: "ic1", hidden: false }, { method: "POST", path: "/ic1", form: { hide: "false" } }],
  ["delete_instagram_comment", { comment_id: "ic1" }, { method: "DELETE", path: "/ic1" }],
  ["list_conversations", { platform: "instagram" }, { method: "GET", path: "/111/conversations", query: { platform: "instagram" } }],
  ["list_conversation_messages", { conversation_id: "t_1" }, { method: "GET", path: "/t_1/messages", query: { fields: "id,created_time,from,to,message,attachments" } }],
  ["send_message", { recipient_id: "psid1", text: "halo" }, { method: "POST", path: "/111/messages", json: { recipient: { id: "psid1" }, messaging_type: "RESPONSE", message: { text: "halo" } } }],
  [
    "send_message",
    { recipient_id: "psid1", attachment_url: "https://img.test/a.png", attachment_type: "image", messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" },
    {
      method: "POST",
      path: "/111/messages",
      json: {
        recipient: { id: "psid1" },
        messaging_type: "MESSAGE_TAG",
        tag: "HUMAN_AGENT",
        message: { attachment: { type: "image", payload: { url: "https://img.test/a.png", is_reusable: false } } },
      },
    },
  ],
  ["api_request", { method: "GET", path: "/me/accounts", query: { limit: 2 } }, { method: "GET", path: "/me/accounts", query: { limit: "2" } }],
];

for (const [operationName, args, expectedRequest] of REQUEST_CASES) {
  test(`${operationName} ${JSON.stringify(args)} sends ${expectedRequest.method} ${expectedRequest.path}`, async () => {
    const { calls } = await runWithResponses(operationName, args);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, expectedRequest.method);
    assert.equal(call.path, BASE_PATH + expectedRequest.path);
    assert.equal(call.headers.authorization, "Bearer page-token");
    for (const [field, expectedSubset] of Object.entries({ query: expectedRequest.query, form: expectedRequest.form })) {
      for (const [key, expectedValue] of Object.entries(expectedSubset ?? {})) assert.equal(call[field]?.[key], expectedValue, `${field}.${key}`);
    }
    if (expectedRequest.json) assert.deepEqual(call.json, expectedRequest.json);
  });
}

test("list operations return data and next_cursor only when paging.next exists", async () => {
  const withNext = await runWithResponses("list_page_posts", {}, [{ body: { data: [{ id: "p1" }], paging: { cursors: { after: "A" }, next: "https://graph.facebook.com/next" } } }]);
  assert.deepEqual(withNext.output, { data: [{ id: "p1" }], next_cursor: "A" });
  const lastPage = await runWithResponses("list_page_posts", {}, [{ body: { data: [], paging: { cursors: { after: "B" } } } }]);
  assert.deepEqual(lastPage.output, { data: [], next_cursor: null });
});

test("list_comments includes the total count summary", async () => {
  const { output } = await runWithResponses("list_comments", { object_id: "p1" }, [{ body: { data: [], summary: { total_count: 7 } } }]);
  assert.deepEqual(output.data, { comments: [], total_count: 7 });
});

test("create_page_post requires a message or a link", async () => {
  await assert.rejects(runWithResponses("create_page_post", {}), (error) => error.kind === "invalid_input");
});

test("send_message requires exactly one of text or attachment_url", async () => {
  await assert.rejects(runWithResponses("send_message", { recipient_id: "p" }), (error) => error.kind === "invalid_input");
  await assert.rejects(
    runWithResponses("send_message", { recipient_id: "p", text: "a", attachment_url: "https://x.test/a.png" }),
    (error) => error.kind === "invalid_input",
  );
});

test("send_message with MESSAGE_TAG requires a tag", async () => {
  await assert.rejects(
    runWithResponses("send_message", { recipient_id: "p", text: "a", messaging_type: "MESSAGE_TAG" }),
    (error) => error.kind === "invalid_input" && /tag/.test(error.message),
  );
});

test("operations that need a Page id fail clearly when neither argument nor env provides one", async () => {
  const environmentWithoutPage = { ...TEST_ENVIRONMENT, META_PAGE_ID: undefined };
  await assert.rejects(
    runWithResponses("list_page_posts", {}, [], environmentWithoutPage),
    (error) => error.kind === "invalid_input" && /META_PAGE_ID/.test(error.message),
  );
});

test("META_GRAPH_VERSION overrides the version and is validated", async () => {
  const { calls } = await runWithResponses("get_page", {}, [{ body: {} }], { ...TEST_ENVIRONMENT, META_GRAPH_VERSION: "v27.0" });
  assert.equal(calls[0].path, "/v27.0/111");
  await assert.rejects(
    runWithResponses("get_page", {}, [], { ...TEST_ENVIRONMENT, META_GRAPH_VERSION: "27" }),
    (error) => error.kind === "invalid_input" && /META_GRAPH_VERSION/.test(error.message),
  );
});
