import { test } from "node:test";
import assert from "node:assert/strict";
import { buildColumnNames } from "../operations/records.mjs";
import { isInvalidInput, runWithResponses } from "./helpers.mjs";

const ID = "sheet1";
const SHEET_VALUES = {
  range: "'Orders'!A1:D5",
  majorDimension: "ROWS",
  values: [
    ["Order ID", "Customer", "Status", "Total"],
    ["A-1", "Budi", "paid", "10"],
    ["A-2", "Siti", "New", "25"],
    ["A-3", "budi santoso", "new"],
    ["A-4", "Andi", "shipped", "5"],
  ],
};
const sheetResponse = { body: SHEET_VALUES };
const keyColumnResponse = (columnValues) => ({ body: { values: columnValues.map((cellValue) => (cellValue === undefined ? [] : [cellValue])) } });
const ORDER_ID_COLUMN = keyColumnResponse(["Order ID", "A-1", "A-2", "A-3", "A-4"]);

test("buildColumnNames fills blanks with column letters and suffixes duplicates", () => {
  assert.deepEqual(buildColumnNames(["Name", "", "Name", " Qty ", null]), ["Name", "B", "Name_2", "Qty", "E"]);
});

test("find_rows reads the whole sheet and filters case-insensitively by default", async () => {
  const { calls, output } = await runWithResponses(
    "find_rows",
    { spreadsheet_id: ID, sheet: "Orders", filters: [{ column: "Status", operator: "equals", value: "NEW" }] },
    [sheetResponse],
  );
  assert.equal(decodeURIComponent(calls[0].path), `/v4/spreadsheets/${ID}/values/'Orders'`);
  assert.equal(calls[0].query.valueRenderOption, "FORMATTED_VALUE");
  assert.deepEqual(output, {
    data: [
      { row_number: 3, record: { "Order ID": "A-2", Customer: "Siti", Status: "New", Total: "25" } },
      { row_number: 4, record: { "Order ID": "A-3", Customer: "budi santoso", Status: "new", Total: "" } },
    ],
    next_cursor: null,
  });
});

test("find_rows operators, match any and case_sensitive", async () => {
  const cases = [
    [{ filters: [{ column: "Customer", operator: "contains", value: "budi" }] }, [2, 4]],
    [{ filters: [{ column: "Customer", operator: "contains", value: "budi" }], case_sensitive: true }, [4]],
    [{ filters: [{ column: "Status", operator: "not_equals", value: "new" }] }, [2, 5]],
    [{ filters: [{ column: "Customer", operator: "not_contains", value: "i" }] }, []],
    [{ filters: [{ column: "Total", operator: "is_empty" }] }, [4]],
    [{ filters: [{ column: "Total", operator: "not_empty" }] }, [2, 3, 5]],
    [{ filters: [{ column: "Status", value: "paid" }, { column: "Status", value: "shipped" }], match: "any" }, [2, 5]],
    [{ filters: [{ column: "Status", value: "new" }, { column: "Total", value: "25" }] }, [3]],
    [{}, [2, 3, 4, 5]],
    [{ match: "any" }, [2, 3, 4, 5]],
  ];
  for (const [extraArgs, expectedRowNumbers] of cases) {
    const { output } = await runWithResponses("find_rows", { spreadsheet_id: ID, sheet: "Orders", ...extraArgs }, [sheetResponse]);
    assert.deepEqual(output.data.map((match) => match.row_number), expectedRowNumbers, JSON.stringify(extraArgs));
  }
});

test("find_rows paginates matches with an offset cursor", async () => {
  const firstPage = await runWithResponses("find_rows", { spreadsheet_id: ID, sheet: "Orders", limit: 3 }, [sheetResponse]);
  assert.deepEqual(firstPage.output.data.map((match) => match.row_number), [2, 3, 4]);
  assert.equal(firstPage.output.next_cursor, "3");
  const lastPage = await runWithResponses("find_rows", { spreadsheet_id: ID, sheet: "Orders", limit: 3, cursor: "3" }, [sheetResponse]);
  assert.deepEqual(lastPage.output.data.map((match) => match.row_number), [5]);
  assert.equal(lastPage.output.next_cursor, null);
});

test("find_rows validation", async () => {
  const invalidCases = [
    { filters: [{ column: "Nope", value: "x" }] },
    { filters: [{ column: "Status", operator: "regex", value: "x" }] },
    { filters: [{ column: "Status", operator: "equals" }] },
    { filters: ["Status=new"] },
    { cursor: "abc" },
    { filters: Array.from({ length: 21 }, () => ({ column: "Status", value: "x" })) },
  ];
  for (const extraArgs of invalidCases) {
    await assert.rejects(runWithResponses("find_rows", { spreadsheet_id: ID, sheet: "Orders", ...extraArgs }, [sheetResponse]), isInvalidInput, JSON.stringify(extraArgs));
  }
  await assert.rejects(runWithResponses("find_rows", { spreadsheet_id: ID, sheet: "Empty" }, [{ body: { range: "Empty!A1:Z1000" } }]), (error) => isInvalidInput(error) && /header row/.test(error.message));
});

test("upsert_row updates only the record's cells of the matching row", async () => {
  const { calls, output } = await runWithResponses(
    "upsert_row",
    { spreadsheet_id: ID, sheet: "Orders", key_column: "Order ID", record: { "Order ID": "A-3", Status: "paid", Total: 30 } },
    [sheetResponse, ORDER_ID_COLUMN, { body: { totalUpdatedCells: 3 } }],
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[0].query.valueRenderOption, "FORMATTED_VALUE");
  assert.equal(decodeURIComponent(calls[1].path), `/v4/spreadsheets/${ID}/values/'Orders'!A:A`);
  assert.equal(calls[1].query.valueRenderOption, "UNFORMATTED_VALUE");
  assert.equal(calls[2].method, "POST");
  assert.equal(calls[2].path, `/v4/spreadsheets/${ID}/values:batchUpdate`);
  assert.deepEqual(calls[2].json, {
    valueInputOption: "USER_ENTERED",
    data: [
      { range: "'Orders'!A4", values: [["'A-3"]] },
      { range: "'Orders'!C4", values: [["paid"]] },
      { range: "'Orders'!D4", values: [[30]] },
    ],
  });
  assert.deepEqual(output.data, { action: "updated", row_number: 4, updated_cells: 3, key: "A-3" });
});

test("upsert_row appends a row aligned to the header when the key is new", async () => {
  const appendBody = { updates: { updatedRange: "Orders!A6:C6", updatedRows: 1 } };
  const { calls, output } = await runWithResponses(
    "upsert_row",
    { spreadsheet_id: ID, sheet: "Orders", key_column: "Order ID", record: { Status: "new", "Order ID": "A-9", Customer: null }, value_input_option: "RAW" },
    [sheetResponse, ORDER_ID_COLUMN, { body: appendBody }],
  );
  assert.equal(decodeURIComponent(calls[2].path), `/v4/spreadsheets/${ID}/values/'Orders'!A1:append`);
  assert.deepEqual(calls[2].query, { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" });
  assert.deepEqual(calls[2].json, { majorDimension: "ROWS", values: [["A-9", "", "new"]] });
  assert.deepEqual(output.data, { action: "inserted", row_number: 6, updated_range: "Orders!A6:C6", key: "A-9" });
});

test("upsert_row key matching is exact after trimming", async () => {
  const { output } = await runWithResponses(
    "upsert_row",
    { spreadsheet_id: ID, sheet: "Orders", key_column: "Customer", record: { Customer: "budi", Status: "x" } },
    [sheetResponse, keyColumnResponse(["Customer", "Budi", "Siti", "budi santoso", "Andi"]), { body: { updates: { updatedRange: "Orders!A6:C6" } } }],
  );
  assert.equal(output.data.action, "inserted");
});

test("upsert_row validation", async () => {
  const invalidCases = [
    { key_column: "Nope", record: { Nope: "1" } },
    { key_column: "Order ID", record: { "Order ID": "A-1", Unknown: "x" } },
    { key_column: "Order ID", record: { Status: "paid" } },
    { key_column: "Order ID", record: { "Order ID": " " } },
    { key_column: "Order ID", record: { "Order ID": "A-1", Status: { nested: 1 } } },
    { key_column: "Order ID", record: {} },
  ];
  for (const extraArgs of invalidCases) {
    await assert.rejects(runWithResponses("upsert_row", { spreadsheet_id: ID, sheet: "Orders", ...extraArgs }, [sheetResponse]), isInvalidInput, JSON.stringify(extraArgs));
  }
});

test("upsert_row's append after an unknown outcome is not retried and names find_rows", async () => {
  await assert.rejects(
    runWithResponses(
      "upsert_row",
      { spreadsheet_id: ID, sheet: "Orders", key_column: "Order ID", record: { "Order ID": "A-9" } },
      [sheetResponse, ORDER_ID_COLUMN, { status: 500, body: { error: { code: 500, message: "internal", status: "INTERNAL" } } }, { body: {} }],
    ),
    (error) => error.retryable === false && /find_rows/.test(error.message) && /A-9/.test(error.message),
  );
});

const PHONE_SHEET = {
  values: [
    ["Phone", "Name"],
    ["+6281234567890", "Budi"],
    ["007", "Bond"],
    ["11/18/2026", "Launch"],
    ["1,234", "Big"],
  ],
};
const PHONE_SHEET_UNFORMATTED = keyColumnResponse(["Phone", "+6281234567890", "007", "2026-11-18", 1234]);

test("upsert_row matches phone, leading-zero, date and number keys against formatted or unformatted values", async () => {
  const cases = [
    ["+6281234567890", 2],
    ["007", 3],
    ["2026-11-18", 4],
    ["11/18/2026", 4],
    [1234, 5],
    ["1234", 5],
  ];
  for (const [keyValue, expectedRowNumber] of cases) {
    const { output } = await runWithResponses(
      "upsert_row",
      { spreadsheet_id: ID, sheet: "Contacts", key_column: "Phone", record: { Phone: keyValue, Name: "x" } },
      [{ body: PHONE_SHEET }, PHONE_SHEET_UNFORMATTED, { body: { totalUpdatedCells: 2 } }],
    );
    assert.deepEqual([output.data.action, output.data.row_number], ["updated", expectedRowNumber], JSON.stringify(keyValue));
  }
});

test("upsert_row writes a text key verbatim under USER_ENTERED so it is not parsed as a number or date", async () => {
  const cases = [
    ["+6281234567890", "'+6281234567890"],
    ["007", "'007"],
    ["2026-11-18", "'2026-11-18"],
    ["=HYPERLINK(\"x\")", "'=HYPERLINK(\"x\")"],
    [42, 42],
  ];
  for (const [keyValue, expectedCell] of cases) {
    const { calls } = await runWithResponses(
      "upsert_row",
      { spreadsheet_id: ID, sheet: "Contacts", key_column: "Phone", record: { Name: "n", Phone: keyValue } },
      [{ body: { values: [["Phone", "Name"]] } }, keyColumnResponse(["Phone"]), { body: { updates: { updatedRange: "Contacts!A2:B2" } } }],
    );
    assert.deepEqual(calls[2].json.values, [[expectedCell, "n"]], JSON.stringify(keyValue));
  }
  const { calls: rawCalls } = await runWithResponses(
    "upsert_row",
    { spreadsheet_id: ID, sheet: "Contacts", key_column: "Phone", record: { Phone: "007" }, value_input_option: "RAW" },
    [{ body: { values: [["Phone", "Name"]] } }, keyColumnResponse(["Phone"]), { body: { updates: { updatedRange: "Contacts!A2:A2" } } }],
  );
  assert.deepEqual(rawCalls[2].json.values, [["007"]]);
});

test("upsert_row parses the inserted row number after the last '!' of the range", async () => {
  const { output } = await runWithResponses(
    "upsert_row",
    { spreadsheet_id: ID, sheet: "Q1!2", key_column: "Order ID", record: { "Order ID": "A-9" } },
    [sheetResponse, ORDER_ID_COLUMN, { body: { updates: { updatedRange: "'Q1!2'!A6:A6" } } }],
  );
  assert.equal(output.data.row_number, 6);
});
