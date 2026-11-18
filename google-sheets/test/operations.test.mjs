import { test } from "node:test";
import assert from "node:assert/strict";
import { isInvalidInput, runWithResponses } from "./helpers.mjs";

const BASE_PATH = "/v4";
const ID = "sheet1";

// Each case: operation + args -> expected single request: method, decoded path, query subset, full json when given.
const REQUEST_CASES = [
  ["get_spreadsheet", { spreadsheet_id: ID }, { method: "GET", path: `/spreadsheets/${ID}`, query: { fields: /^spreadsheetId,spreadsheetUrl,properties\(title/ } }],
  [
    "create_spreadsheet",
    { title: "Orders", sheet_titles: ["2026", "Archive"], locale: "id_ID", time_zone: "Asia/Jakarta" },
    {
      method: "POST",
      path: "/spreadsheets",
      json: { properties: { title: "Orders", locale: "id_ID", timeZone: "Asia/Jakarta" }, sheets: [{ properties: { title: "2026" } }, { properties: { title: "Archive" } }] },
    },
  ],
  ["create_spreadsheet", { title: "Plain" }, { method: "POST", path: "/spreadsheets", json: { properties: { title: "Plain" } } }],
  [
    "add_sheet",
    { spreadsheet_id: ID, title: "Q4", index: 0, row_count: 100, column_count: 5 },
    { method: "POST", path: `/spreadsheets/${ID}:batchUpdate`, json: { requests: [{ addSheet: { properties: { title: "Q4", index: 0, gridProperties: { rowCount: 100, columnCount: 5 } } } }] } },
  ],
  [
    "read_range",
    { spreadsheet_id: ID, sheet: "My Sheet", range: "A1:C", value_render_option: "UNFORMATTED_VALUE", date_time_render_option: "SERIAL_NUMBER" },
    {
      method: "GET",
      path: `/spreadsheets/${ID}/values/'My Sheet'!A1:C`,
      query: { majorDimension: "ROWS", valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" },
    },
  ],
  ["read_range", { spreadsheet_id: ID, sheet: "Jon's Data" }, { method: "GET", path: `/spreadsheets/${ID}/values/'Jon''s Data'` }],
  ["read_range", { spreadsheet_id: ID, range: "A1:B2" }, { method: "GET", path: `/spreadsheets/${ID}/values/A1:B2` }],
  [
    "append_rows",
    { spreadsheet_id: ID, sheet: "Orders", rows: [["A-1", 2, true, null]] },
    {
      method: "POST",
      path: `/spreadsheets/${ID}/values/'Orders':append`,
      query: { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" },
      json: { majorDimension: "ROWS", values: [["A-1", 2, true, null]] },
    },
  ],
  [
    "append_rows",
    { spreadsheet_id: ID, rows: [["x"]], value_input_option: "RAW", insert_data_option: "OVERWRITE" },
    { method: "POST", path: `/spreadsheets/${ID}/values/A1:append`, query: { valueInputOption: "RAW", insertDataOption: "OVERWRITE" } },
  ],
  [
    "update_range",
    { spreadsheet_id: ID, sheet: "Orders", range: "B2", rows: [["paid"]] },
    { method: "PUT", path: `/spreadsheets/${ID}/values/'Orders'!B2`, query: { valueInputOption: "USER_ENTERED" }, json: { majorDimension: "ROWS", values: [["paid"]] } },
  ],
  ["clear_range", { spreadsheet_id: ID, sheet: "Orders", range: "A2:Z" }, { method: "POST", path: `/spreadsheets/${ID}/values/'Orders'!A2:Z:clear` }],
  [
    "api_request",
    { method: "POST", path: `/spreadsheets/${ID}/developerMetadata:search`, body: { dataFilters: [] } },
    { method: "POST", path: `/spreadsheets/${ID}/developerMetadata:search`, json: { dataFilters: [] } },
  ],
];

for (const [operationName, args, expectedRequest] of REQUEST_CASES) {
  test(`${operationName} ${JSON.stringify(args)} sends ${expectedRequest.method} ${expectedRequest.path}`, async () => {
    // Writes through api_request are workflow-only: agents (tool calls) may only GET.
    const source = operationName === "api_request" && expectedRequest.method !== "GET" ? "node" : "tool";
    const { calls } = await runWithResponses(operationName, args, [{ body: {} }], undefined, source);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, expectedRequest.method);
    assert.equal(decodeURIComponent(call.path), BASE_PATH + expectedRequest.path);
    assert.equal(call.headers.authorization, "Bearer google-token");
    for (const [key, expectedValue] of Object.entries(expectedRequest.query ?? {})) {
      if (expectedValue instanceof RegExp) assert.match(call.query[key], expectedValue, `query.${key}`);
      else assert.equal(call.query[key], expectedValue, `query.${key}`);
    }
    if (expectedRequest.json) assert.deepEqual(call.json, expectedRequest.json);
  });
}

test("clear_range sends no body", async () => {
  const { calls } = await runWithResponses("clear_range", { spreadsheet_id: ID, sheet: "Orders", whole_sheet: true }, [{ body: { clearedRange: "Orders!A1:Z1000" } }]);
  assert.equal(calls[0].body, undefined);
});

test("clear_range clears a whole sheet only with an explicit whole_sheet: true", async () => {
  const { calls } = await runWithResponses("clear_range", { spreadsheet_id: ID, sheet: "Orders", whole_sheet: true }, [{ body: {} }]);
  assert.equal(decodeURIComponent(calls[0].path), `${BASE_PATH}/spreadsheets/${ID}/values/'Orders':clear`);
  const refusedCases = [
    { sheet: "Orders" },
    { sheet: "Orders", range: "" },
    { sheet: "Orders", range: "", whole_sheet: false },
    { sheet: "Orders", range: "A1:B2", whole_sheet: true },
    { whole_sheet: true },
  ];
  for (const extraArgs of refusedCases) {
    await assert.rejects(runWithResponses("clear_range", { spreadsheet_id: ID, ...extraArgs }, []), isInvalidInput, JSON.stringify(extraArgs));
  }
});

test("clear_range server failures are retryable because clearing is idempotent", async () => {
  await assert.rejects(
    runWithResponses("clear_range", { spreadsheet_id: ID, sheet: "Orders", range: "A2:Z" }, [{ status: 503, body: { error: { code: 503, message: "unavailable", status: "UNAVAILABLE" } } }]),
    (error) => {
      assert.equal(error.retryable, true);
      assert.match(error.message, /safe to retry/);
      return true;
    },
  );
});

test("spreadsheet_id accepts a full spreadsheet URL", async () => {
  const url = `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`;
  const { calls } = await runWithResponses("read_range", { spreadsheet_id: url, range: "A1" }, [{ body: {} }]);
  assert.equal(decodeURIComponent(calls[0].path), `${BASE_PATH}/spreadsheets/${ID}/values/A1`);
  const { calls: getCalls } = await runWithResponses("get_spreadsheet", { spreadsheet_id: `https://docs.google.com/spreadsheets/u/0/d/${ID}` }, [{ body: {} }]);
  assert.equal(decodeURIComponent(getCalls[0].path), `${BASE_PATH}/spreadsheets/${ID}`);
});

test("the range is one encoded path segment: '/', '?' and '#' in a sheet name cannot change the path", async () => {
  const { calls } = await runWithResponses("read_range", { spreadsheet_id: ID, sheet: "a/b?c#d", range: "A1" }, [{ body: {} }]);
  assert.equal(calls[0].path, `/v4/spreadsheets/${ID}/values/'a%2Fb%3Fc%23d'!A1`);
  assert.deepEqual(Object.keys(calls[0].query).sort(), ["majorDimension", "valueRenderOption"]);
  assert.equal(new URL(calls[0].url).hash, "");
});

test("batch_read repeats the ranges parameter and quotes sheet names", async () => {
  const valueRanges = [{ range: "'My Sheet'!A1:B2", majorDimension: "ROWS", values: [["a"]] }, { range: "Other!C1" }];
  const { calls, output } = await runWithResponses("batch_read", { spreadsheet_id: ID, ranges: ["My Sheet!A1:B2", "'Other'!C1"] }, [{ body: { valueRanges } }]);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, `/v4/spreadsheets/${ID}/values:batchGet`);
  assert.deepEqual(url.searchParams.getAll("ranges"), ["'My Sheet'!A1:B2", "'Other'!C1"]);
  assert.equal(url.searchParams.get("valueRenderOption"), "FORMATTED_VALUE");
  assert.deepEqual(output.data, {
    value_ranges: [
      { range: "'My Sheet'!A1:B2", major_dimension: "ROWS", values: [["a"]] },
      { range: "Other!C1", major_dimension: "ROWS", values: [] },
    ],
  });
});

test("batch_read with sheet qualifies every range", async () => {
  const { calls } = await runWithResponses("batch_read", { spreadsheet_id: ID, sheet: "S 1", ranges: ["A1", "B2:C3"] }, [{ body: {} }]);
  assert.deepEqual(new URL(calls[0].url).searchParams.getAll("ranges"), ["'S 1'!A1", "'S 1'!B2:C3"]);
  await assert.rejects(runWithResponses("batch_read", { spreadsheet_id: ID, ranges: [] }), isInvalidInput);
});

test("get_spreadsheet condenses the metadata", async () => {
  const spreadsheet = {
    spreadsheetId: ID,
    spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet1/edit",
    properties: { title: "Orders", locale: "en_US", timeZone: "Asia/Jakarta" },
    sheets: [{ properties: { sheetId: 0, title: "Sheet1", index: 0, sheetType: "GRID", gridProperties: { rowCount: 1000, columnCount: 26 } } }],
  };
  const { output } = await runWithResponses("get_spreadsheet", { spreadsheet_id: ID }, [{ body: spreadsheet }]);
  assert.deepEqual(output.data, {
    spreadsheet_id: ID,
    title: "Orders",
    url: "https://docs.google.com/spreadsheets/d/sheet1/edit",
    locale: "en_US",
    time_zone: "Asia/Jakarta",
    sheets: [{ sheet_id: 0, title: "Sheet1", index: 0, sheet_type: "GRID", hidden: false, row_count: 1000, column_count: 26, frozen_row_count: 0 }],
  });
});

test("add_sheet returns the new sheet's properties", async () => {
  const replies = [{ addSheet: { properties: { sheetId: 42, title: "Q4", index: 1, sheetType: "GRID", gridProperties: { rowCount: 1000, columnCount: 26 } } } }];
  const { output } = await runWithResponses("add_sheet", { spreadsheet_id: ID, title: "Q4" }, [{ body: { replies } }]);
  assert.equal(output.data.sheet_id, 42);
  assert.equal(output.data.title, "Q4");
});

test("append_rows summarizes the update", async () => {
  const body = { spreadsheetId: ID, tableRange: "Orders!A1:C4", updates: { updatedRange: "Orders!A5:C5", updatedRows: 1, updatedColumns: 3, updatedCells: 3 } };
  const { output } = await runWithResponses("append_rows", { spreadsheet_id: ID, sheet: "Orders", rows: [["a", "b", "c"]] }, [{ body }]);
  assert.deepEqual(output.data, { updated_range: "Orders!A5:C5", updated_rows: 1, updated_columns: 3, updated_cells: 3, table_range: "Orders!A1:C4" });
});

test("append_rows is never retried after a server error or network failure and says how to check", async () => {
  await assert.rejects(
    runWithResponses("append_rows", { spreadsheet_id: ID, sheet: "Orders", rows: [["a"]] }, [{ status: 503, body: { error: { code: 503, message: "unavailable", status: "UNAVAILABLE" } } }, { body: {} }]),
    (error) => {
      assert.equal(error.retryable, false);
      assert.match(error.message, /outcome unknown/);
      assert.match(error.message, /read_range/);
      return true;
    },
  );
  const { createOperationRunner } = await import("../lib/shared/operations.mjs");
  const { pluginDefinition } = await import("../definition.mjs");
  let callCount = 0;
  const failingFetch = async () => {
    callCount += 1;
    throw new TypeError("fetch failed");
  };
  const runOperation = createOperationRunner(pluginDefinition, { GOOGLE_ACCESS_TOKEN: "t" }, { fetchImpl: failingFetch });
  await assert.rejects(runOperation("append_rows", { spreadsheet_id: ID, rows: [["a"]] }, { source: "tool" }), (error) => error.kind === "network_error" && error.retryable === false);
  assert.equal(callCount, 1);
});

test("validation: rows, ranges and sheet names", async () => {
  const invalidCases = [
    ["append_rows", { spreadsheet_id: ID, rows: [] }],
    ["append_rows", { spreadsheet_id: ID, rows: [[{ nested: true }]] }],
    ["append_rows", { spreadsheet_id: ID, rows: ["not-a-row"] }],
    ["update_range", { spreadsheet_id: ID, range: "A1", rows: [[["x"]]] }],
    ["read_range", { spreadsheet_id: ID }],
    ["read_range", { spreadsheet_id: ID, sheet: "S", range: "Other!A1" }],
    ["read_range", { spreadsheet_id: ID, range: "Sheet1!not a range" }],
    ["read_range", { spreadsheet_id: ID, range: "'Unclosed!A1" }],
    ["read_range", { spreadsheet_id: ID, range: "'Jon's'!A1" }],
    ["read_range", { spreadsheet_id: ID, sheet: "x".repeat(101) }],
    ["read_range", { spreadsheet_id: ID, sheet: "tab\tname" }],
    ["read_range", { spreadsheet_id: "..", range: "A1" }],
    ["create_spreadsheet", { title: "T", sheet_titles: ["a", "a"] }],
  ];
  for (const [operationName, args] of invalidCases) {
    await assert.rejects(runWithResponses(operationName, args, []), isInvalidInput, `${operationName} ${JSON.stringify(args)}`);
  }
});
