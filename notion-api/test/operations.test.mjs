import { test } from "node:test";
import assert from "node:assert/strict";
import { DATA_SOURCE_ID, PAGE_ID, runWithResponses } from "./helpers.mjs";
import { NOTION_VERSION } from "../lib/client.mjs";

const PAGE_URL = `https://www.notion.so/acme/Roadmap-${PAGE_ID}?pvs=4`;
const paragraph = (content) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content } }] } });

// Each case: operation + args -> the single request: method, path (after /v1), query subset, full json when given.
const REQUEST_CASES = [
  [
    "search",
    { query: "Roadmap", object_type: "page", limit: 10, cursor: "c1" },
    { method: "POST", path: "/search", json: { query: "Roadmap", filter: { property: "object", value: "page" }, sort: { timestamp: "last_edited_time", direction: "descending" }, start_cursor: "c1", page_size: 10 } },
  ],
  ["search", {}, { method: "POST", path: "/search", json: { sort: { timestamp: "last_edited_time", direction: "descending" } } }],
  ["get_page", { page_id: PAGE_ID }, { method: "GET", path: `/pages/${PAGE_ID}` }],
  ["get_page", { page_id: PAGE_URL }, { method: "GET", path: `/pages/${PAGE_ID}` }],
  ["get_page_property", { page_id: PAGE_ID, property_id: "a%3Db", limit: 50, cursor: "c2" }, { method: "GET", path: `/pages/${PAGE_ID}/properties/a%3Db`, query: { page_size: "50", start_cursor: "c2" } }],
  ["archive_page", { page_id: PAGE_ID }, { method: "PATCH", path: `/pages/${PAGE_ID}`, json: { in_trash: true } }],
  ["restore_page", { page_id: PAGE_ID }, { method: "PATCH", path: `/pages/${PAGE_ID}`, json: { in_trash: false } }],
  [
    "update_page_properties",
    { page_id: PAGE_ID, properties: { Stage: { select: { name: "Won" } } } },
    { method: "PATCH", path: `/pages/${PAGE_ID}`, json: { properties: { Stage: { select: { name: "Won" } } } } },
  ],
  [
    "create_page",
    { parent_page_id: PAGE_URL, values: { title: "Meeting notes" }, paragraphs: ["Agenda"], icon_emoji: "📞" },
    {
      method: "POST",
      path: "/pages",
      json: {
        parent: { type: "page_id", page_id: PAGE_ID },
        properties: { title: { title: [{ type: "text", text: { content: "Meeting notes" } }] } },
        children: [paragraph("Agenda")],
        icon: { type: "emoji", emoji: "📞" },
      },
    },
  ],
  [
    "create_page",
    { data_source_id: DATA_SOURCE_ID, properties: { Name: { title: [] } } },
    { method: "POST", path: "/pages", json: { parent: { type: "data_source_id", data_source_id: DATA_SOURCE_ID }, properties: { Name: { title: [] } } } },
  ],
  ["get_database", { database_id: PAGE_ID }, { method: "GET", path: `/databases/${PAGE_ID}` }],
  ["get_data_source", { data_source_id: DATA_SOURCE_ID }, { method: "GET", path: `/data_sources/${DATA_SOURCE_ID}` }],
  [
    "query_database",
    { data_source_id: DATA_SOURCE_ID, filter: { property: "Stage", select: { equals: "Won" } }, sorts: [{ property: "Due", direction: "ascending" }], limit: 20, cursor: "c3" },
    {
      method: "POST",
      path: `/data_sources/${DATA_SOURCE_ID}/query`,
      json: { filter: { property: "Stage", select: { equals: "Won" } }, sorts: [{ property: "Due", direction: "ascending" }], start_cursor: "c3", page_size: 20 },
    },
  ],
  ["get_block_children", { block_id: PAGE_ID, limit: 100 }, { method: "GET", path: `/blocks/${PAGE_ID}/children`, query: { page_size: "100" } }],
  ["append_paragraphs", { block_id: PAGE_ID, paragraphs: ["One", "Two"] }, { method: "PATCH", path: `/blocks/${PAGE_ID}/children`, json: { children: [paragraph("One"), paragraph("Two")] } }],
  [
    "append_paragraphs",
    { block_id: PAGE_ID, paragraphs: ["After"], after_block_id: "b1" },
    { method: "PATCH", path: `/blocks/${PAGE_ID}/children`, json: { children: [paragraph("After")], position: { type: "after_block", after_block: { id: "b1" } } } },
  ],
  ["append_paragraphs", { block_id: PAGE_ID, paragraphs: ["First"], at_start: true }, { method: "PATCH", path: `/blocks/${PAGE_ID}/children`, json: { children: [paragraph("First")], position: { type: "start" } } }],
  ["add_comment", { page_id: PAGE_ID, text: "Looks good" }, { method: "POST", path: "/comments", json: { parent: { page_id: PAGE_ID }, rich_text: [{ type: "text", text: { content: "Looks good" } }] } }],
  ["add_comment", { block_id: "blk", text: "Here" }, { method: "POST", path: "/comments", json: { parent: { block_id: "blk" }, rich_text: [{ type: "text", text: { content: "Here" } }] } }],
  ["add_comment", { discussion_id: "d1", text: "Reply" }, { method: "POST", path: "/comments", json: { discussion_id: "d1", rich_text: [{ type: "text", text: { content: "Reply" } }] } }],
  ["api_request", { path: "/users/me" }, { method: "GET", path: "/users/me" }],
];

for (const [operationName, args, expectedRequest] of REQUEST_CASES) {
  test(`${operationName} ${JSON.stringify(args)} sends ${expectedRequest.method} ${expectedRequest.path}`, async () => {
    const { calls } = await runWithResponses(operationName, args);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, expectedRequest.method);
    assert.equal(call.path, `/v1${expectedRequest.path}`);
    assert.equal(call.headers.authorization, "Bearer ntn_test_secret_token");
    assert.equal(call.headers["notion-version"], NOTION_VERSION);
    for (const [key, expectedValue] of Object.entries(expectedRequest.query ?? {})) assert.equal(call.query[key], expectedValue, `query.${key}`);
    if (expectedRequest.json) assert.deepEqual(call.json, expectedRequest.json);
  });
}

test("the Notion version is 2026-03-11, the newest documented version", () => {
  assert.equal(NOTION_VERSION, "2026-03-11");
});

test("list operations map has_more/next_cursor to next_cursor", async () => {
  const more = await runWithResponses("search", {}, [{ body: { object: "list", results: [{ id: "p" }], has_more: true, next_cursor: "next-1" } }]);
  assert.equal(more.output.next_cursor, "next-1");
  assert.deepEqual(more.output.data.results, [{ id: "p" }]);
  const last = await runWithResponses("get_block_children", { block_id: PAGE_ID }, [{ body: { results: [], has_more: false, next_cursor: null } }]);
  assert.equal(last.output.next_cursor, null);
  const single = await runWithResponses("get_page_property", { page_id: PAGE_ID, property_id: "num" }, [{ body: { object: "property_item", type: "number", number: 3 } }]);
  assert.equal(single.output.next_cursor, null);
});
