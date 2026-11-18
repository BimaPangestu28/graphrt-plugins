import { test } from "node:test";
import assert from "node:assert/strict";
import { pluginDefinition } from "../definition.mjs";
import { airtableError, BASE_ID, OTHER_BASE_ID, RECORD_ID, RECORD_ID_2, runWithResponses, TEST_ENVIRONMENT } from "./helpers.mjs";

// Each case: operation + args -> the single request: method, decoded path (after /v0), query subset, full json when given.
const REQUEST_CASES = [
  ["list_bases", {}, { method: "GET", path: "/meta/bases" }],
  ["list_bases", { cursor: "itr1" }, { method: "GET", path: "/meta/bases", query: { offset: "itr1" } }],
  ["get_base_schema", {}, { method: "GET", path: `/meta/bases/${BASE_ID}/tables` }],
  ["get_base_schema", { base_id: OTHER_BASE_ID }, { method: "GET", path: `/meta/bases/${OTHER_BASE_ID}/tables` }, { source: "node" }],
  [
    "list_records",
    {
      table: "Leads",
      view: "Open",
      filter_by_formula: '{Status} = "Open"',
      sort: [{ field: "Created", direction: "desc" }],
      fields: ["Name", "Email"],
      limit: 50,
      max_records: 500,
      return_fields_by_field_id: true,
      cursor: "itr2/rec1",
    },
    {
      method: "POST",
      path: `/${BASE_ID}/Leads/listRecords`,
      json: {
        view: "Open",
        filterByFormula: '{Status} = "Open"',
        sort: [{ field: "Created", direction: "desc" }],
        fields: ["Name", "Email"],
        pageSize: 50,
        maxRecords: 500,
        returnFieldsByFieldId: true,
        offset: "itr2/rec1",
      },
    },
  ],
  ["list_records", { table: "Sales / 2026" }, { method: "POST", path: `/${BASE_ID}/Sales / 2026/listRecords`, json: {} }],
  [
    "find_records",
    { table: "Leads", where: { Email: "a@b.co" }, fields: ["Name"] },
    { method: "POST", path: `/${BASE_ID}/Leads/listRecords`, json: { filterByFormula: '{Email} & "" = "a@b.co"', fields: ["Name"] } },
  ],
  ["get_record", { table: "tblXXXXXXXXXXXXXX", record_id: RECORD_ID }, { method: "GET", path: `/${BASE_ID}/tblXXXXXXXXXXXXXX/${RECORD_ID}` }],
  [
    "create_records",
    { table: "Leads", records: [{ fields: { Name: "Acme" } }], typecast: true },
    { method: "POST", path: `/${BASE_ID}/Leads`, json: { records: [{ fields: { Name: "Acme" } }], typecast: true } },
    { source: "node" },
  ],
  [
    "update_records",
    { table: "Leads", records: [{ id: RECORD_ID, fields: { Status: "Won" } }] },
    { method: "PATCH", path: `/${BASE_ID}/Leads`, json: { records: [{ id: RECORD_ID, fields: { Status: "Won" } }], typecast: false } },
  ],
  [
    "upsert_records",
    { table: "Leads", records: [{ fields: { Email: "a@b.co", Name: "Ana" } }], fields_to_merge_on: ["Email"] },
    {
      method: "PATCH",
      path: `/${BASE_ID}/Leads`,
      json: { records: [{ fields: { Email: "a@b.co", Name: "Ana" } }], typecast: false, performUpsert: { fieldsToMergeOn: ["Email"] } },
    },
  ],
  ["api_request", { path: "/meta/whoami" }, { method: "GET", path: "/meta/whoami" }],
];

for (const [operationName, args, expectedRequest, runOptions] of REQUEST_CASES) {
  test(`${operationName} ${JSON.stringify(args)} sends ${expectedRequest.method} ${expectedRequest.path}`, async () => {
    const { calls } = await runWithResponses(operationName, args, undefined, runOptions);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, expectedRequest.method);
    assert.equal(decodeURIComponent(call.path), `/v0${expectedRequest.path}`);
    assert.equal(call.headers.authorization, "Bearer patTestSecretToken.123");
    for (const [key, expectedValue] of Object.entries(expectedRequest.query ?? {})) assert.equal(call.query[key], expectedValue, `query.${key}`);
    if (expectedRequest.json) assert.deepEqual(call.json, expectedRequest.json);
  });
}

test("a table name with slashes or ? stays one path segment", async () => {
  const { calls } = await runWithResponses("get_record", { table: "a/b?c#d", record_id: RECORD_ID });
  assert.equal(calls[0].path, `/v0/${BASE_ID}/a%2Fb%3Fc%23d/${RECORD_ID}`);
});

test("delete_records (workflow node) sends repeated records[] query parameters", async () => {
  const { calls } = await runWithResponses("delete_records", { table: "Leads", record_ids: [RECORD_ID, RECORD_ID_2] }, [{ body: { records: [] } }], { source: "node" });
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].path, `/v0/${BASE_ID}/Leads`);
  assert.deepEqual(new URL(calls[0].url).searchParams.getAll("records[]"), [RECORD_ID, RECORD_ID_2]);
});

test("delete_records is node only: not a tool, and refused from a tool call", async () => {
  const deleteOperation = pluginDefinition.operations.find((operation) => operation.name === "delete_records");
  assert.equal(deleteOperation.nodeOnly, true);
  await assert.rejects(runWithResponses("delete_records", { table: "Leads", record_ids: [RECORD_ID] }, []), (error) => error.kind === "invalid_input" && /Unknown operation/.test(error.message));
});

test("list operations map Airtable's offset to next_cursor", async () => {
  const more = await runWithResponses("list_records", { table: "Leads" }, [{ body: { records: [{ id: RECORD_ID }], offset: "itr3/rec9" } }]);
  assert.equal(more.output.next_cursor, "itr3/rec9");
  const last = await runWithResponses("find_records", { table: "Leads", where: { Name: "x" } }, [{ body: { records: [] } }]);
  assert.equal(last.output.next_cursor, null);
  assert.equal(last.output.data.filter_by_formula, '{Name} & "" = "x"');
  const bases = await runWithResponses("list_bases", {}, [{ body: { bases: [], offset: "b2" } }]);
  assert.equal(bases.output.next_cursor, "b2");
});

test("find_records sends an injection attempt as one escaped literal", async () => {
  const attempt = '") , TRUE()) & ("\n';
  const { calls } = await runWithResponses("find_records", { table: "Leads", where: { Name: attempt }, match: "case_insensitive" });
  assert.equal(calls[0].json.filterByFormula, 'LOWER({Name} & "") = LOWER("\\") , TRUE()) & (\\"\\n")');
});

test("delete_records retried after a 5xx counts ids that are then not found as already deleted", async () => {
  const serverError = { ...airtableError(503, "RETRIABLE_ERROR"), headers: { "retry-after": "0" } };
  for (const notFound of [airtableError(404, "NOT_FOUND"), airtableError(422, "INVALID_RECORDS")]) {
    const { calls, output } = await runWithResponses("delete_records", { table: "Leads", record_ids: [RECORD_ID] }, [serverError, notFound], { source: "node" });
    assert.equal(calls.length, 2);
    assert.deepEqual(output.data, { records: [{ id: RECORD_ID, deleted: true }], already_absent: true });
  }
  const recovered = await runWithResponses("delete_records", { table: "Leads", record_ids: [RECORD_ID] }, [serverError, { body: { records: [{ id: RECORD_ID, deleted: true }] } }], { source: "node" });
  assert.deepEqual(recovered.output.data, { records: [{ id: RECORD_ID, deleted: true }] });
});

test("delete_records: a not-found on the first attempt (or after a 429) stays an error", async () => {
  await assert.rejects(
    runWithResponses("delete_records", { table: "Leads", record_ids: [RECORD_ID] }, [airtableError(404, "NOT_FOUND")], { source: "node" }),
    (error) => error.kind === "not_found",
  );
  const rateLimited = { ...airtableError(429, "RATE_LIMIT_REACHED"), headers: { "retry-after": "0" } };
  await assert.rejects(
    runWithResponses("delete_records", { table: "Leads", record_ids: [RECORD_ID] }, [rateLimited, airtableError(404, "NOT_FOUND")], { source: "node" }),
    (error) => error.kind === "not_found",
  );
});

test("tool calls force typecast false; workflow nodes keep it", async () => {
  const args = { table: "Leads", records: [{ id: RECORD_ID, fields: { Stage: "New" } }], typecast: true };
  const toolRun = await runWithResponses("update_records", args);
  assert.equal(toolRun.calls[0].json.typecast, false);
  const nodeRun = await runWithResponses("update_records", args, undefined, { source: "node" });
  assert.equal(nodeRun.calls[0].json.typecast, true);
});

test("upsert_records de-duplicates fields_to_merge_on", async () => {
  const args = { table: "Leads", records: [{ fields: { Email: "a@b.co" } }], fields_to_merge_on: ["Email", "Email"] };
  const { calls } = await runWithResponses("upsert_records", args);
  assert.deepEqual(calls[0].json.performUpsert, { fieldsToMergeOn: ["Email"] });
});

const DENIED_BASE_TOOL_CALLS = [
  ["list_records", { table: "T", base_id: OTHER_BASE_ID }],
  ["get_base_schema", { base_id: OTHER_BASE_ID }],
  ["create_records", { table: "T", base_id: OTHER_BASE_ID, records: [{ fields: {} }] }],
  ["api_request", { path: `/meta/bases/${OTHER_BASE_ID}/tables` }],
  ["api_request", { path: `/${OTHER_BASE_ID}/T?maxRecords=1` }],
  ["api_request", { path: `/%61pp${OTHER_BASE_ID.slice(3)}/T` }],
  ["api_request", { path: `/${BASE_ID}/../${OTHER_BASE_ID}/T` }],
];

for (const [operationName, args] of DENIED_BASE_TOOL_CALLS) {
  test(`tool ${operationName} ${JSON.stringify(args)} is refused outside the allowed bases`, async () => {
    await assert.rejects(runWithResponses(operationName, args, []), (error) => error.kind === "permission_denied" && /AIRTABLE_TOOL_ALLOWED_BASES/.test(error.message));
  });
}

test("allowed bases: AIRTABLE_BASE_ID, AIRTABLE_TOOL_ALLOWED_BASES, * and nodes", async () => {
  const args = { table: "T", base_id: OTHER_BASE_ID };
  const listed = { ...TEST_ENVIRONMENT, AIRTABLE_TOOL_ALLOWED_BASES: ` appCCCCCCCCCCCCCC , ${OTHER_BASE_ID}` };
  for (const runOptions of [{ environment: listed }, { environment: { ...TEST_ENVIRONMENT, AIRTABLE_TOOL_ALLOWED_BASES: "*" } }, { source: "node" }, { environment: { AIRTABLE_TOKEN: "patX" } }]) {
    const { calls } = await runWithResponses("list_records", args, [{ body: {} }], runOptions);
    assert.equal(calls.length, 1, JSON.stringify(runOptions));
  }
  for (const path of ["/meta/bases", "/meta/whoami", `/${BASE_ID}/T`]) {
    const { calls } = await runWithResponses("api_request", { path }, [{ body: {} }]);
    assert.equal(calls.length, 1, path);
  }
  const nodeRequest = await runWithResponses("api_request", { path: `/${OTHER_BASE_ID}/T` }, [{ body: {} }], { source: "node" });
  assert.equal(nodeRequest.calls.length, 1);
});
