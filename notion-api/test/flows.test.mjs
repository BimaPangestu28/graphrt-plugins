import { test } from "node:test";
import assert from "node:assert/strict";
import { DATA_SOURCE_ID, DATABASE_ID, PAGE_ID, isInvalidInput, notionError, runWithResponses } from "./helpers.mjs";
import { extractNotionId, parseNotionError } from "../lib/client.mjs";

const DATA_SOURCE = {
  object: "data_source",
  id: DATA_SOURCE_ID,
  properties: { Name: { id: "title", type: "title" }, Price: { id: "p%3Dx", type: "number" }, Stage: { id: "s", type: "select" } },
};
const SINGLE_SOURCE_DATABASE = { object: "database", id: DATABASE_ID, data_sources: [{ id: DATA_SOURCE_ID, name: "Deals" }] };
const titleText = (content) => [{ type: "text", text: { content } }];

test("create_page with database_id resolves its only data source, reads the schema and maps values", async () => {
  const { calls } = await runWithResponses(
    "create_page",
    { database_id: DATABASE_ID, values: { Name: "Acme", Price: "1200", Stage: "Lead" }, properties: { Stage: { select: { name: "Won" } } } },
    [{ body: SINGLE_SOURCE_DATABASE }, { body: DATA_SOURCE }, { body: { object: "page", id: "new" } }],
  );
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    `GET /v1/databases/${DATABASE_ID}`,
    `GET /v1/data_sources/${DATA_SOURCE_ID}`,
    "POST /v1/pages",
  ]);
  assert.deepEqual(calls[2].json, {
    parent: { type: "data_source_id", data_source_id: DATA_SOURCE_ID },
    // Raw `properties` win over `values` for the same name.
    properties: { Name: { title: titleText("Acme") }, Price: { number: 1200 }, Stage: { select: { name: "Won" } } },
  });
});

test("query_database with a multi-source database asks for data_source_id and lists the choices", async () => {
  const twoSources = { data_sources: [{ id: "ds-a", name: "Leads" }, { id: "ds-b", name: "Deals" }] };
  await assert.rejects(
    runWithResponses("query_database", { database_id: DATABASE_ID }, [{ body: twoSources }]),
    (error) => isInvalidInput(error) && /2 data sources/.test(error.message) && /Leads = ds-a; Deals = ds-b/.test(error.message),
  );
});

test("query_database with database_id queries the resolved data source", async () => {
  const { calls } = await runWithResponses("query_database", { database_id: DATABASE_ID }, [{ body: SINGLE_SOURCE_DATABASE }, { body: { results: [] } }]);
  assert.equal(calls[1].path, `/v1/data_sources/${DATA_SOURCE_ID}/query`);
});

test("update_page_properties with values reads the page's property types first", async () => {
  const page = { object: "page", properties: { Name: { id: "title", type: "title" }, Done: { id: "d", type: "checkbox" } } };
  const { calls } = await runWithResponses("update_page_properties", { page_id: PAGE_ID, values: { Done: true } }, [{ body: page }, { body: {} }]);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "PATCH"]);
  assert.deepEqual(calls[1].json, { properties: { Done: { checkbox: true } } });
});

test("get_page_property with property_name looks up the id on the page", async () => {
  const page = { properties: { Notes: { id: "ab%3Ac", type: "rich_text" } } };
  const { calls } = await runWithResponses("get_page_property", { page_id: PAGE_ID, property_name: "Notes" }, [{ body: page }, { body: { results: [] } }]);
  assert.equal(calls[1].path, `/v1/pages/${PAGE_ID}/properties/ab%3Ac`);
});

// Each case: operation, args -> invalid_input message pattern (no request is sent).
const VALIDATION_CASES = [
  ["create_page", { values: { title: "x" } }, /exactly one of `parent_page_id`/],
  ["create_page", { parent_page_id: PAGE_ID, data_source_id: DATA_SOURCE_ID }, /exactly one of `parent_page_id`/],
  ["create_page", { parent_page_id: PAGE_ID, values: { Name: "x" } }, /Unknown property "Name".*title/],
  ["create_page", { parent_page_id: PAGE_ID, paragraphs: Array.from({ length: 101 }, () => "p") }, /at most 100 items/],
  ["update_page_properties", { page_id: PAGE_ID }, /`values` and\/or `properties`/],
  ["append_paragraphs", { block_id: PAGE_ID, paragraphs: [] }, /at least one/],
  ["append_paragraphs", { block_id: PAGE_ID, paragraphs: Array.from({ length: 101 }, () => "p") }, /at most 100 items/],
  ["append_paragraphs", { block_id: PAGE_ID, paragraphs: ["x"], after_block_id: "b", at_start: true }, /not both/],
  ["add_comment", { text: "hi" }, /exactly one of `page_id`/],
  ["add_comment", { page_id: PAGE_ID, block_id: "b", text: "hi" }, /exactly one of `page_id`/],
  ["get_page_property", { page_id: PAGE_ID }, /exactly one of `property_id`/],
  ["query_database", {}, /`data_source_id` or `database_id`/],
  ["get_page", { page_id: "https://www.notion.so/no-id-here" }, /No Notion id/],
  ["get_page", { page_id: ".." }, /Invalid id/],
  ["get_page", { page_id: "https://exa mple.com:99999/x" }, /Invalid Notion URL/],
  ["append_paragraphs", { block_id: PAGE_ID, paragraphs: Array.from({ length: 3 }, () => "x".repeat(150000)) }, /400000 characters/],
];

for (const [operationName, args, messagePattern] of VALIDATION_CASES) {
  test(`${operationName} rejects ${JSON.stringify(args).slice(0, 60)}`, async () => {
    await assert.rejects(runWithResponses(operationName, args, []), (error) => isInvalidInput(error) && messagePattern.test(error.message));
  });
}

test("extractNotionId takes the last 32-hex id from a URL path and leaves plain ids alone", () => {
  assert.equal(extractNotionId(`https://acme.notion.site/Page-${PAGE_ID}`), PAGE_ID);
  assert.equal(extractNotionId(`https://www.notion.so/${"a".repeat(32)}?v=${"b".repeat(32)}`), "a".repeat(32));
  assert.equal(extractNotionId(" 1234-abcd "), "1234-abcd");
});

test("extractNotionId prefers the peeked page (`p`) over the database in the path and accepts dashed UUIDs", () => {
  const databaseId = "a".repeat(32);
  assert.equal(extractNotionId(`https://www.notion.so/acme/${databaseId}?v=${"b".repeat(32)}&p=${PAGE_ID}&pm=s`), PAGE_ID);
  assert.equal(extractNotionId(`https://www.notion.so/${databaseId}?p=not-an-id`), databaseId);
  assert.equal(extractNotionId(`https://www.notion.so/${databaseId}?p=${DATA_SOURCE_ID}`), DATA_SOURCE_ID);
  assert.equal(extractNotionId(`https://www.notion.so/acme/Page-${DATA_SOURCE_ID}`), DATA_SOURCE_ID);
});

test("extractNotionId turns a malformed URL into invalid_input, not a TypeError", () => {
  assert.throws(() => extractNotionId("https://"), (error) => isInvalidInput(error) && /Invalid Notion URL/.test(error.message));
});

test("tool calls may not set people properties unless NOTION_TOOL_ALLOW_PEOPLE=1; nodes may", async () => {
  const rawPeople = { page_id: PAGE_ID, properties: { Owner: { people: [{ id: "user-1" }] } } };
  await assert.rejects(runWithResponses("update_page_properties", rawPeople, [{ body: {} }]), (error) => error.kind === "permission_denied" && /NOTION_TOOL_ALLOW_PEOPLE/.test(error.message));
  const typedPeople = { data_source_id: DATA_SOURCE_ID, properties: { Owner: { type: "people", people: [] } } };
  await assert.rejects(runWithResponses("create_page", typedPeople, [{ body: {} }]), (error) => error.kind === "permission_denied");
  const pageWithPeople = { properties: { Owner: { id: "o", type: "people" } } };
  await assert.rejects(
    runWithResponses("update_page_properties", { page_id: PAGE_ID, values: { Owner: "x" } }, [{ body: pageWithPeople }]),
    (error) => error.kind === "permission_denied",
  );
  const { calls } = await runWithResponses("update_page_properties", rawPeople, [{ body: {} }], "node");
  assert.deepEqual(calls[0].json, { properties: rawPeople.properties });
  const allowed = await runWithResponses("update_page_properties", rawPeople, [{ body: {} }], "tool", { NOTION_TOOL_ALLOW_PEOPLE: "1" });
  assert.equal(allowed.calls[0].method, "PATCH");
});

test("append_paragraphs accepts up to 400000 characters in total", async () => {
  const { calls } = await runWithResponses("append_paragraphs", { block_id: PAGE_ID, paragraphs: ["x".repeat(200000), "y".repeat(200000)] }, [{ body: {} }]);
  assert.equal(calls.length, 1);
});

// Each case: status, code -> kind.
const ERROR_CASES = [
  [401, "unauthorized", "auth_error"],
  [403, "restricted_resource", "permission_denied"],
  [404, "object_not_found", "not_found"],
  [429, "rate_limited", "rate_limited"],
  [400, "validation_error", "invalid_input"],
  [400, "invalid_json", "invalid_input"],
  [400, "missing_version", "invalid_input"],
  [529, "service_overload", "rate_limited"],
];

for (const [status, code, expectedKind] of ERROR_CASES) {
  test(`parseNotionError maps ${status} ${code} to ${expectedKind}`, () => {
    assert.equal(parseNotionError(status, notionError(status, code).body).kind, expectedKind);
  });
}

test("parseNotionError adds a sharing hint to not_found, marks conflicts retryable and ignores other bodies", () => {
  assert.match(parseNotionError(404, notionError(404, "object_not_found", "Could not find page").body).message, /Could not find page \(object_not_found\)\. Share the page/);
  assert.deepEqual(parseNotionError(409, notionError(409, "conflict_error").body), { message: "m (conflict_error); nothing was saved, safe to retry", kind: "api_error", retryable: true });
  assert.deepEqual(parseNotionError(502, { text: "Bad gateway" }), {});
  assert.equal(parseNotionError(529, {}).kind, "rate_limited");
});

test("an invalid token is auth_error end to end and the token is never echoed", async () => {
  await assert.rejects(
    runWithResponses("search", {}, [notionError(401, "unauthorized", "API token is invalid. ntn_test_secret_token")]),
    (error) => error.kind === "auth_error" && /API token is invalid/.test(error.message) && !error.message.includes("ntn_test_secret_token"),
  );
});

test("429 is honoured with Retry-After and retried, also for create_page (nothing was written)", async () => {
  const rateLimited = { ...notionError(429, "rate_limited"), headers: { "retry-after": "0" } };
  const { calls, output } = await runWithResponses("create_page", { data_source_id: DATA_SOURCE_ID, properties: {} }, [rateLimited, { body: { id: "new" } }]);
  assert.equal(calls.length, 2);
  assert.equal(output.data.id, "new");
});

test("create_page is not retried after a 5xx: the failure is not retryable and says how to check", async () => {
  await assert.rejects(
    runWithResponses("create_page", { data_source_id: DATA_SOURCE_ID, properties: {} }, [notionError(500, "internal_server_error"), { body: {} }]),
    (error) => error.retryable === false && /outcome unknown/.test(error.message) && /search for the page/.test(error.message),
  );
});

test("append_paragraphs and add_comment are not retried after a 5xx", async () => {
  for (const [operationName, args] of [
    ["append_paragraphs", { block_id: PAGE_ID, paragraphs: ["x"] }],
    ["add_comment", { page_id: PAGE_ID, text: "x" }],
  ]) {
    const responses = [notionError(503, "service_unavailable"), { body: {} }];
    await assert.rejects(runWithResponses(operationName, args, responses), (error) => error.retryable === false && /To check/.test(error.message));
  }
});

test("archive_page (idempotent) is retried after a 5xx", async () => {
  const { calls } = await runWithResponses("archive_page", { page_id: PAGE_ID }, [{ ...notionError(502, "bad_gateway"), headers: { "retry-after": "0" } }, { body: { in_trash: true } }]);
  assert.equal(calls.length, 2);
});

test("api_request is read-only for tools but allows writes from workflow nodes", async () => {
  await assert.rejects(runWithResponses("api_request", { method: "DELETE", path: `/blocks/${PAGE_ID}` }), (error) => error.kind === "permission_denied");
  const { calls } = await runWithResponses("api_request", { method: "DELETE", path: `/blocks/${PAGE_ID}` }, [{ body: {} }], "node");
  assert.equal(calls[0].method, "DELETE");
});
