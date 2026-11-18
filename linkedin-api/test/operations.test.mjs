import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithResponses, TEST_ENVIRONMENT } from "./helpers.mjs";

const BASE_PATH = "/rest";
const SHARE_URN = "urn:li:share:123";
const ENCODED_SHARE_URN = "urn%3Ali%3Ashare%3A123";
const ORGANIZATION_URN = "urn:li:organization:42";
const ENCODED_ORGANIZATION_URN = "urn%3Ali%3Aorganization%3A42";
const COMMENT_URN = "urn:li:comment:(urn:li:activity:1,2)";
const ENCODED_COMMENT_URN = "urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A1%2C2%29";

// Each case: operation + args → expected single request (method, path, and a subset of query/headers, exact json).
const REQUEST_CASES = [
  ["get_post", { post_urn: SHARE_URN }, { method: "GET", path: `/posts/${ENCODED_SHARE_URN}`, query: { viewContext: "AUTHOR" } }],
  [
    "list_organization_posts",
    {},
    { method: "GET", path: "/posts", query: { q: "author", author: ORGANIZATION_URN, count: "25", start: "0" }, headers: { "x-restli-method": "FINDER" } },
  ],
  [
    "list_organization_posts",
    { author_urn: "urn:li:organization:7", limit: 10, cursor: "50", sort_by: "CREATED" },
    { method: "GET", path: "/posts", query: { author: "urn:li:organization:7", count: "10", start: "50", sortBy: "CREATED" } },
  ],
  [
    "update_post",
    { post_urn: SHARE_URN, text: "edited" },
    {
      method: "POST",
      path: `/posts/${ENCODED_SHARE_URN}`,
      headers: { "x-restli-method": "PARTIAL_UPDATE" },
      json: { patch: { $set: { commentary: "edited" } } },
    },
  ],
  ["delete_post", { post_urn: SHARE_URN }, { method: "DELETE", path: `/posts/${ENCODED_SHARE_URN}`, headers: { "x-restli-method": "DELETE" } }],
  ["list_comments", { target_urn: SHARE_URN }, { method: "GET", path: `/socialActions/${ENCODED_SHARE_URN}/comments`, query: { start: "0", count: "25" } }],
  [
    "create_comment",
    { target_urn: SHARE_URN, text: "nice" },
    {
      method: "POST",
      path: `/socialActions/${ENCODED_SHARE_URN}/comments`,
      json: { actor: ORGANIZATION_URN, object: SHARE_URN, message: { text: "nice" } },
    },
  ],
  [
    "create_comment",
    { target_urn: SHARE_URN, text: "reply", actor: "urn:li:person:abc", parent_comment_urn: COMMENT_URN },
    {
      method: "POST",
      path: `/socialActions/${ENCODED_COMMENT_URN}/comments`,
      json: { actor: "urn:li:person:abc", object: SHARE_URN, message: { text: "reply" }, parentComment: COMMENT_URN },
    },
  ],
  [
    "update_comment",
    { target_urn: SHARE_URN, comment_id: "2", text: "fixed" },
    {
      method: "POST",
      path: `/socialActions/${ENCODED_SHARE_URN}/comments/2`,
      query: { actor: ORGANIZATION_URN },
      headers: { "x-restli-method": "PARTIAL_UPDATE" },
      json: { patch: { message: { $set: { text: "fixed" } } } },
    },
  ],
  [
    "update_comment",
    { target_urn: SHARE_URN, comment_id: COMMENT_URN, text: "fixed" },
    { method: "POST", path: `/socialActions/${ENCODED_SHARE_URN}/comments/2` },
  ],
  [
    "delete_comment",
    { target_urn: SHARE_URN, comment_id: "2" },
    { method: "DELETE", path: `/socialActions/${ENCODED_SHARE_URN}/comments/2`, query: { actor: ORGANIZATION_URN }, headers: { "x-restli-method": "DELETE" } },
  ],
  [
    "add_reaction",
    { target_urn: SHARE_URN },
    { method: "POST", path: "/reactions", query: { actor: ORGANIZATION_URN }, json: { root: SHARE_URN, reactionType: "LIKE" } },
  ],
  [
    "add_reaction",
    { target_urn: COMMENT_URN, reaction_type: "praise", actor: "urn:li:person:abc" },
    { method: "POST", path: "/reactions", query: { actor: "urn:li:person:abc" }, json: { root: COMMENT_URN, reactionType: "PRAISE" } },
  ],
  [
    "remove_reaction",
    { target_urn: SHARE_URN },
    { method: "DELETE", path: `/reactions/(actor:${ENCODED_ORGANIZATION_URN},entity:${ENCODED_SHARE_URN})`, headers: { "x-restli-method": "DELETE" } },
  ],
  [
    "list_reactions",
    { target_urn: SHARE_URN, sort: "REVERSE_CHRONOLOGICAL" },
    {
      method: "GET",
      path: `/reactions/(entity:${ENCODED_SHARE_URN})`,
      query: { q: "entity", sort: "REVERSE_CHRONOLOGICAL", start: "0", count: "25" },
      headers: { "x-restli-method": "FINDER" },
    },
  ],
  ["api_request", { method: "GET", path: "/organizations/42", query: { fields: "id" } }, { method: "GET", path: "/organizations/42", query: { fields: "id" } }],
];

for (const [operationName, args, expectedRequest] of REQUEST_CASES) {
  test(`${operationName} ${JSON.stringify(args)} sends ${expectedRequest.method} ${expectedRequest.path}`, async () => {
    const { calls } = await runWithResponses(operationName, args);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, expectedRequest.method);
    assert.equal(call.path, BASE_PATH + expectedRequest.path);
    assert.equal(call.headers.authorization, "Bearer li-token");
    assert.equal(call.headers["linkedin-version"], "202611");
    assert.equal(call.headers["x-restli-protocol-version"], "2.0.0");
    for (const [field, expectedSubset] of Object.entries({ query: expectedRequest.query, headers: expectedRequest.headers })) {
      for (const [key, expectedValue] of Object.entries(expectedSubset ?? {})) assert.equal(call[field]?.[key], expectedValue, `${field}.${key}`);
    }
    if (expectedRequest.json) assert.deepEqual(call.json, expectedRequest.json);
  });
}

test("get_userinfo calls the OpenID userinfo endpoint and adds person_urn", async () => {
  const { output, calls } = await runWithResponses("get_userinfo", {}, [{ body: { sub: "Ab12", name: "Bima" } }]);
  assert.equal(calls[0].url, "https://api.linkedin.com/v2/userinfo");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.authorization, "Bearer li-token");
  assert.deepEqual(output.data, { sub: "Ab12", name: "Bima", person_urn: "urn:li:person:Ab12" });
});

const POST_CREATED = [{ status: 201, body: "", headers: { "x-restli-id": "urn:li:share:1" } }];
const DEFAULT_DISTRIBUTION = { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] };

test("create_post sends a text post and returns the URN from x-restli-id", async () => {
  const { output, calls } = await runWithResponses("create_post", { text: "Hello" }, [
    { status: 201, body: "", headers: { "x-restli-id": "urn:li:share:999" } },
  ]);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/rest/posts");
  assert.deepEqual(calls[0].json, {
    author: ORGANIZATION_URN,
    commentary: "Hello",
    visibility: "PUBLIC",
    distribution: DEFAULT_DISTRIBUTION,
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  });
  assert.deepEqual(output.data, { id: "urn:li:share:999", url: "https://www.linkedin.com/feed/update/urn:li:share:999/" });
});

test("create_post attaches an image with alt text", async () => {
  const { calls } = await runWithResponses("create_post", {
    author: "urn:li:person:abc",
    text: "Pic",
    visibility: "connections",
    image_urn: "urn:li:image:C1",
    image_alt_text: "A cat",
  }, POST_CREATED);
  assert.equal(calls[0].json.author, "urn:li:person:abc");
  assert.equal(calls[0].json.visibility, "CONNECTIONS");
  assert.deepEqual(calls[0].json.content, { media: { id: "urn:li:image:C1", altText: "A cat" } });
});

test("create_post attaches an article", async () => {
  const { calls } = await runWithResponses("create_post", {
    text: "Read",
    article_url: "https://blog.test/a",
    article_title: "A",
    article_description: "About A",
    article_thumbnail_urn: "urn:li:image:T1",
  }, POST_CREATED);
  assert.deepEqual(calls[0].json.content, {
    article: { source: "https://blog.test/a", title: "A", description: "About A", thumbnail: "urn:li:image:T1" },
  });
});

test("create_post and update_post escape Little Text Format characters unless little_text_format is set", async () => {
  const escaped = await runWithResponses("create_post", { text: "Hi (all) #tag @me" }, POST_CREATED);
  assert.equal(escaped.calls[0].json.commentary, "Hi \\(all\\) \\#tag \\@me");
  const raw = await runWithResponses("create_post", { text: "{hashtag|\\#|tag}", little_text_format: true }, POST_CREATED);
  assert.equal(raw.calls[0].json.commentary, "{hashtag|\\#|tag}");
  const updated = await runWithResponses("update_post", { post_urn: SHARE_URN, text: "a_b" });
  assert.equal(updated.calls[0].json.patch.$set.commentary, "a\\_b");
});

test("create_post fails with api_error when LinkedIn returns no x-restli-id", async () => {
  await assert.rejects(runWithResponses("create_post", { text: "x" }, [{ status: 201, body: "" }]), (error) => error.kind === "api_error");
});

test("update_post and delete_post return the post URN", async () => {
  const { output } = await runWithResponses("delete_post", { post_urn: SHARE_URN }, [{ status: 204 }]);
  assert.deepEqual(output.data, { id: SHARE_URN, deleted: true });
  const updated = await runWithResponses("update_post", { post_urn: SHARE_URN, text: "x" }, [{ status: 204 }]);
  assert.deepEqual(updated.output.data, { id: SHARE_URN, updated: true });
});

test("create_comment and add_reaction include the x-restli-id when the body lacks an id", async () => {
  const { output } = await runWithResponses("create_comment", { target_urn: SHARE_URN, text: "hi" }, [
    { status: 201, body: { message: { text: "hi" } }, headers: { "x-restli-id": "7" } },
  ]);
  assert.deepEqual(output.data, { message: { text: "hi" }, id: "7" });
});

test("list operations map elements and paging to data and next_cursor", async () => {
  const fullPage = await runWithResponses("list_comments", { target_urn: SHARE_URN, limit: 2 }, [
    { body: { elements: [{ id: "1" }, { id: "2" }], paging: { start: 0, count: 2, links: [] } } },
  ]);
  assert.deepEqual(fullPage.output, { data: [{ id: "1" }, { id: "2" }], next_cursor: "2" });
  const withNextLink = await runWithResponses("list_comments", { target_urn: SHARE_URN, limit: 2, cursor: "4" }, [
    { body: { elements: [{ id: "5" }], paging: { start: 4, count: 2, links: [{ rel: "next", href: "/rest/socialActions/x/comments?start=6" }] } } },
  ]);
  assert.equal(withNextLink.output.next_cursor, "6");
  const lastPage = await runWithResponses("list_comments", { target_urn: SHARE_URN, limit: 2 }, [{ body: { elements: [{ id: "1" }], paging: { start: 0, count: 2 } } }]);
  assert.deepEqual(lastPage.output, { data: [{ id: "1" }], next_cursor: null });
  const totalReached = await runWithResponses("list_reactions", { target_urn: SHARE_URN, limit: 2, cursor: "2" }, [
    { body: { elements: [{}, {}], paging: { start: 2, count: 2, total: 4 } } },
  ]);
  assert.equal(totalReached.output.next_cursor, null);
});

for (const [label, operationName, invalidArgs, expectedMessage] of [
  ["a non-numeric cursor", "list_comments", { target_urn: SHARE_URN, cursor: "abc" }, /cursor/],
  ["a negative cursor", "list_comments", { target_urn: SHARE_URN, cursor: "-5" }, /cursor/],
  ["an unsupported visibility", "create_post", { text: "x", visibility: "FRIENDS" }, /visibility/],
  ["a company author URN", "create_post", { text: "x", author: "urn:li:company:1" }, /urn:li:organization:/],
  ["both an image and an article", "create_post", { text: "x", image_urn: "urn:li:image:1", article_url: "https://a.test" }, /not both/],
  ["an article title without article_url", "create_post", { text: "x", article_title: "A" }, /article_url/],
  ["a non-image image_urn", "create_post", { text: "x", image_urn: "urn:li:video:1" }, /urn:li:image:/],
  ["a non-https article_url", "create_post", { text: "x", article_url: "http://a.test" }, /https/],
  ["an unknown reaction type", "add_reaction", { target_urn: SHARE_URN, reaction_type: "LOVE" }, /reaction_type/],
  ["a target that is not a URN", "list_comments", { target_urn: "123" }, /target_urn/],
  ["a post that is not a URN", "get_post", { post_urn: "share:123" }, /post_urn/],
  ["an actor that is not a person or organization", "delete_comment", { target_urn: SHARE_URN, comment_id: "2", actor: "urn:li:share:1" }, /actor/],
  ["a malformed comment id", "delete_comment", { target_urn: SHARE_URN, comment_id: "a/b" }, /comment_id/],
  ["an empty comment text", "create_comment", { target_urn: SHARE_URN, text: "" }, /text/],
]) {
  test(`rejects ${label} with invalid_input`, async () => {
    await assert.rejects(
      runWithResponses(operationName, invalidArgs, []),
      (error) => error.kind === "invalid_input" && expectedMessage.test(error.message),
    );
  });
}

test("operations that need an author fail clearly when neither argument nor env provides one", async () => {
  const environmentWithoutAuthor = { ...TEST_ENVIRONMENT, LINKEDIN_AUTHOR_URN: undefined };
  await assert.rejects(
    runWithResponses("create_post", { text: "x" }, [], environmentWithoutAuthor),
    (error) => error.kind === "invalid_input" && /LINKEDIN_AUTHOR_URN/.test(error.message),
  );
});

test("an invalid LINKEDIN_AUTHOR_URN is rejected", async () => {
  await assert.rejects(
    runWithResponses("add_reaction", { target_urn: SHARE_URN }, [], { ...TEST_ENVIRONMENT, LINKEDIN_AUTHOR_URN: "42" }),
    (error) => error.kind === "invalid_input" && /urn:li:person:/.test(error.message),
  );
});

test("LINKEDIN_VERSION overrides the version header and is validated", async () => {
  const { calls } = await runWithResponses("get_post", { post_urn: SHARE_URN }, [{ body: {} }], { ...TEST_ENVIRONMENT, LINKEDIN_VERSION: "202612" });
  assert.equal(calls[0].headers["linkedin-version"], "202612");
  await assert.rejects(
    runWithResponses("get_post", { post_urn: SHARE_URN }, [], { ...TEST_ENVIRONMENT, LINKEDIN_VERSION: "2026-11" }),
    (error) => error.kind === "invalid_input" && /LINKEDIN_VERSION/.test(error.message),
  );
});

const SERVER_ERROR = { status: 503, body: { status: 503, message: "Service unavailable" } };
const NOT_FOUND = { status: 404, body: { status: 404, message: "Not found" } };

for (const [operationName, args, expectedData] of [
  ["delete_post", { post_urn: SHARE_URN }, { id: SHARE_URN, deleted: true, already_absent: true }],
  ["delete_comment", { target_urn: SHARE_URN, comment_id: "2" }, { comment_id: "2", deleted: true, already_absent: true }],
  ["remove_reaction", { target_urn: SHARE_URN }, { target_urn: SHARE_URN, removed: true, already_absent: true }],
]) {
  test(`${operationName} retried after a server error that then gets 404 counts as deleted (already_absent)`, async () => {
    const { output, calls } = await runWithResponses(operationName, args, [SERVER_ERROR, NOT_FOUND]);
    assert.equal(calls.length, 2);
    assert.deepEqual(output.data, expectedData);
  });

  test(`${operationName} that gets 404 on its first attempt is still not_found`, async () => {
    await assert.rejects(runWithResponses(operationName, args, [NOT_FOUND]), (error) => error.kind === "not_found");
  });
}

for (const [label, operationName, args] of [
  ["a comment URN from another ugcPost", "update_comment", { target_urn: "urn:li:ugcPost:1", comment_id: "urn:li:comment:(urn:li:ugcPost:2,5)", text: "x" }],
  ["a comment URN from another activity", "delete_comment", { target_urn: "urn:li:activity:1", comment_id: "urn:li:comment:(urn:li:activity:9,5)" }],
  ["a comment URN from another thread than the target comment", "delete_comment", { target_urn: "urn:li:comment:(urn:li:activity:1,4)", comment_id: "urn:li:comment:(urn:li:activity:9,5)" }],
]) {
  test(`rejects ${label} with invalid_input`, async () => {
    await assert.rejects(runWithResponses(operationName, args, []), (error) => error.kind === "invalid_input" && /does not belong to/.test(error.message));
  });
}

test("a comment URN on the same thread as target_urn is accepted", async () => {
  const sameActivity = await runWithResponses("delete_comment", { target_urn: "urn:li:activity:1", comment_id: "urn:li:comment:(urn:li:activity:1,5)" }, [{ status: 204 }]);
  assert.equal(sameActivity.calls[0].path, "/rest/socialActions/urn%3Ali%3Aactivity%3A1/comments/5");
  const replyThread = await runWithResponses("update_comment", { target_urn: "urn:li:comment:(urn:li:activity:1,4)", comment_id: "urn:li:comment:(urn:li:activity:1,5)", text: "x" });
  assert.equal(replyThread.calls.length, 1);
});
