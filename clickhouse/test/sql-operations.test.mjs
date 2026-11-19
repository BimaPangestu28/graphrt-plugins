import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const SERVER = "https://ch.example.com:8443";
const PASSWORD = "s3cret-clickhouse-pass";
const queryResult = { meta: [{ name: "n", type: "UInt64" }], data: [{ n: "3" }], rows: 1, statistics: { elapsed: 0.001 } };

async function run(operationName, args, { source = "tool", environment = {}, responses = [{ body: queryResult }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { CLICKHOUSE_URL: SERVER, CLICKHOUSE_PASSWORD: PASSWORD, ...environment }, { fetchImpl: recordingFetch });
  const outcome = await runner(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("query POSTs the SQL with typed parameters, limits, and readonly=1 as the last setting", async () => {
  const { output, calls } = await run("query", { sql: "SELECT count() AS n FROM events WHERE user_id = {user_id:UInt64} AND tag IN {tags:Array(String)}", parameters: { user_id: 7, tags: ["a", "b'c"] }, database: "analytics" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/");
  assert.equal(calls[0].body, "SELECT count() AS n FROM events WHERE user_id = {user_id:UInt64} AND tag IN {tags:Array(String)}");
  assert.deepEqual(calls[0].queryEntries, [
    ["default_format", "JSON"],
    ["database", "analytics"],
    ["param_user_id", "7"],
    ["param_tags", "['a','b\\'c']"],
    ["max_execution_time", "30"],
    ["max_result_rows", "10000"],
    ["max_result_bytes", "10485760"],
    ["result_overflow_mode", "throw"],
    ["wait_end_of_query", "1"],
    ["readonly", "1"],
  ]);
  assert.equal(calls[0].headers["x-clickhouse-user"], "default");
  assert.equal(calls[0].headers["x-clickhouse-key"], PASSWORD);
  assert.deepEqual(output.data, queryResult);
});

test("query parameter names cannot smuggle settings such as readonly=0", async () => {
  const { error, calls } = await run("query", { sql: "SELECT 1", parameters: { "x&readonly": 0 } });
  assert.equal(error?.kind, "invalid_input");
  assert.equal(calls.length, 0);
  const { calls: okCalls } = await run("query", { sql: "SELECT {readonly:UInt8}", parameters: { readonly: 0 } });
  assert.equal(okCalls[0].query.readonly, "1", "a parameter named readonly is param_readonly, the setting stays 1");
  assert.equal(okCalls[0].query.param_readonly, "0");
});

test("query limits are bounded by the schema", async () => {
  for (const args of [{ max_execution_time: 121 }, { max_result_rows: 0 }, { max_result_bytes: 104857601 }, { result_overflow_mode: "any" }]) {
    const { error, calls } = await run("query", { sql: "SELECT 1", ...args });
    assert.equal(error?.kind, "invalid_input", JSON.stringify(args));
    assert.equal(calls.length, 0);
  }
});

test("a readonly refusal is permission_denied and an auth failure is auth_error, whatever the HTTP status", async () => {
  const readonly = await run("query", { sql: "INSERT INTO t VALUES (1)" }, { responses: [{ status: 403, body: "Code: 164. DB::Exception: default: Cannot execute query in readonly mode. (READONLY) (version 25.10.1.1)", headers: { "content-type": "text/plain" } }] });
  assert.equal(readonly.error?.kind, "permission_denied");
  assert.match(readonly.error.message, /readonly mode/);
  const auth = await run("list_databases", {}, { responses: [{ status: 403, body: "Code: 516. DB::Exception: default: Authentication failed: password is incorrect, or there is no user with such name. (AUTHENTICATION_FAILED)", headers: { "content-type": "text/plain" } }] });
  assert.equal(auth.error?.kind, "auth_error");
});

test("an exception streamed after a 200 status is an error, not data", async () => {
  const streamed = "{\"meta\": [\n__exception__\nCode: 241. DB::Exception: Memory limit exceeded. (MEMORY_LIMIT_EXCEEDED)\n";
  const { error } = await run("query", { sql: "SELECT 1" }, { responses: [{ body: streamed, headers: { "content-type": "text/plain", "x-clickhouse-exception-code": "241" } }] });
  assert.equal(error?.kind, "api_error");
  assert.match(error.message, /Memory limit exceeded/);
});

test("a failed read-only query is not repeated by the client and has no unknown-outcome note", async () => {
  const timeout = "Code: 159. DB::Exception: Timeout exceeded: elapsed 30.0 seconds, maximum: 30. (TIMEOUT_EXCEEDED)";
  const timedOut = await run("query", { sql: "SELECT sleep(3)" }, { responses: [{ status: 500, body: timeout, headers: { "content-type": "text/plain" } }] });
  assert.equal(timedOut.calls.length, 1);
  assert.equal(timedOut.error?.kind, "timeout");
  assert.equal(timedOut.error.message.includes("outcome unknown"), false);
  const unavailable = await run("query", { sql: "SELECT 1" }, { responses: [{ status: 503, body: "Service Unavailable", headers: { "content-type": "text/plain" } }] });
  assert.equal(unavailable.calls.length, 1);
  assert.equal(unavailable.error?.retryable, true);
  assert.equal(unavailable.error.message.includes("outcome unknown"), false);
});

const settingRefusal = (settingName) => ({ status: 500, body: `Code: 164. DB::Exception: Cannot modify '${settingName}' setting in readonly mode. (READONLY)`, headers: { "content-type": "text/plain" } });
const profileReadonly = (value) => ({ body: { data: [{ readonly: value }] } });

test("a readonly=1 user profile: after checking the profile, the query is sent once more without settings", async () => {
  const { output, calls } = await run("query", { sql: "SELECT {n:UInt8}", parameters: { n: 1 } }, { responses: [settingRefusal("max_execution_time"), profileReadonly("1"), { body: queryResult }] });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].query.readonly, "1");
  assert.equal(calls[1].body, "SELECT toString(getSetting('readonly')) AS readonly");
  assert.deepEqual(calls[2].queryEntries, [["default_format", "JSON"], ["param_n", "1"]]);
  assert.deepEqual(output.data, queryResult);
});

const manyRows = (count) => ({ meta: [{ name: "n", type: "UInt64" }], data: Array.from({ length: count }, (_, index) => ({ n: String(index) })), rows: count, statistics: { elapsed: 0.001 } });
const fallbackResponses = (result) => [settingRefusal("max_execution_time"), profileReadonly("1"), { body: result }];

test("readonly=1 fallback: the row cap is still enforced (client-side), throw mode fails without the data", async () => {
  const { error, calls } = await run("query", { sql: "SELECT number AS n FROM numbers(50)", max_result_rows: 10 }, { source: "node", responses: fallbackResponses(manyRows(50)) });
  assert.equal(calls.length, 3);
  assert.equal(error?.kind, "invalid_input");
  assert.match(error.message, /max_result_rows \(10\)/);
  assert.match(error.message, /client-side/);
});

test("readonly=1 fallback: break mode returns the first rows and marks the result truncated", async () => {
  const { output } = await run("query", { sql: "SELECT number AS n FROM numbers(50)", max_result_rows: 10, result_overflow_mode: "break" }, { source: "node", responses: fallbackResponses(manyRows(50)) });
  assert.equal(output.data.data.length, 10);
  assert.equal(output.data.rows, 10);
  assert.equal(output.data.result_truncated, true);
  assert.equal(output.data.data[9].n, "9");
});

test("readonly=1 fallback: the byte cap is enforced on the serialized rows", async () => {
  const wideRows = { meta: [], data: Array.from({ length: 40 }, (_, index) => ({ n: index, filler: "y".repeat(100) })), rows: 40 };
  const thrown = await run("query", { sql: "SELECT 1", max_result_bytes: 1024 }, { source: "node", responses: fallbackResponses(wideRows) });
  assert.equal(thrown.error?.kind, "invalid_input");
  assert.match(thrown.error.message, /max_result_bytes \(1024\)/);
  const broken = await run("query", { sql: "SELECT 1", max_result_bytes: 1024, result_overflow_mode: "break" }, { source: "node", responses: fallbackResponses(wideRows) });
  assert.ok(broken.output.data.data.length > 0 && broken.output.data.data.length < 40);
  assert.ok(Buffer.byteLength(JSON.stringify(broken.output.data.data)) <= 1024);
  assert.equal(broken.output.data.result_truncated, true);
});

test("readonly=1 fallback: a result within the caps is returned unchanged", async () => {
  const { output } = await run("query", { sql: "SELECT 1" }, { source: "node", responses: fallbackResponses(manyRows(3)) });
  assert.deepEqual(output.data, manyRows(3));
});

test("agent tools may ask for at most 10 MB of result (max_result_bytes); nodes up to 100 MB", async () => {
  const refused = await run("query", { sql: "SELECT 1", max_result_bytes: 20 * 1024 * 1024 });
  assert.equal(refused.error?.kind, "invalid_input");
  assert.match(refused.error.message, /10485760/);
  assert.equal(refused.calls.length, 0);
  const node = await run("query", { sql: "SELECT 1", max_result_bytes: 20 * 1024 * 1024 }, { source: "node" });
  assert.equal(node.calls[0].query.max_result_bytes, String(20 * 1024 * 1024));
});

test("a readonly=2 user profile is refused: it would allow SET and table functions", async () => {
  const { error, calls } = await run("query", { sql: "SELECT 1" }, { responses: [settingRefusal("max_execution_time"), profileReadonly("2")] });
  assert.equal(calls.length, 2);
  assert.equal(error?.kind, "permission_denied");
  assert.match(error.message, /readonly=2/);
});

test("a query whose own SETTINGS clause is refused is never resent without readonly", async () => {
  const { error, calls } = await run("query", { sql: "INSERT INTO t SELECT 1 SETTINGS max_threads = 1" }, { responses: [settingRefusal("max_threads"), profileReadonly("0")] });
  assert.equal(calls.length, 2);
  assert.equal(error?.kind, "permission_denied");
  assert.match(error.message, /max_threads/);
});

test("the password is redacted from errors", async () => {
  const { error } = await run("query", { sql: "SELECT 1" }, { responses: [{ status: 400, body: `Code: 62. DB::Exception: Syntax error near ${PASSWORD}. (SYNTAX_ERROR)`, headers: { "content-type": "text/plain" } }] });
  assert.equal(error?.kind, "invalid_input");
  assert.equal(error.message.includes(PASSWORD), false);
});

test("insert_rows sends JSONEachRow into a quoted table and returns written_rows", async () => {
  const summary = JSON.stringify({ read_rows: "2", written_rows: "2", written_bytes: "40" });
  const { output, calls } = await run("insert_rows", { database: "analytics", table: "ev`ents", rows: [{ id: 1 }, { id: 2, note: "x\ny" }] }, { source: "node", responses: [{ body: "", headers: { "x-clickhouse-summary": summary } }] });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].query.query, "INSERT INTO `analytics`.`ev\\`ents` FORMAT JSONEachRow");
  assert.equal(calls[0].query.allow_ddl, "0");
  assert.equal(calls[0].query.readonly, undefined);
  assert.equal(calls[0].body, '{"id":1}\n{"id":2,"note":"x\\ny"}');
  assert.equal(output.data.written_rows, 2);
});

test("insert_rows as a tool needs CLICKHOUSE_TOOL_ALLOW_WRITES=1", async () => {
  const refused = await run("insert_rows", { table: "events", rows: [{ id: 1 }] });
  assert.equal(refused.error?.kind, "permission_denied");
  assert.match(refused.error.message, /CLICKHOUSE_TOOL_ALLOW_WRITES/);
  assert.equal(refused.calls.length, 0);
  const allowed = await run("insert_rows", { table: "events", rows: [{ id: 1 }] }, { environment: { CLICKHOUSE_TOOL_ALLOW_WRITES: "1" }, responses: [{ body: "" }] });
  assert.equal(allowed.error, undefined);
  assert.equal(allowed.calls.length, 1);
});

test("a failed insert is not retried and says how to check", async () => {
  const { error, calls } = await run("insert_rows", { table: "events", rows: [{ id: 1 }] }, { source: "node", responses: [{ status: 503, body: "busy", headers: { "content-type": "text/plain" } }] });
  assert.equal(calls.length, 1);
  assert.equal(error.retryable, false);
  assert.match(error.message, /outcome unknown.*To check: SELECT count\(\) FROM `events`/s);
});

test("execute runs without readonly and is node only", async () => {
  const { calls } = await run("execute", { sql: "ALTER TABLE events DELETE WHERE id = {id:UInt64}", parameters: { id: 9 } }, { source: "node", responses: [{ body: "" }] });
  assert.equal(calls[0].query.readonly, undefined);
  assert.equal(calls[0].query.param_id, "9");
  const asTool = await run("execute", { sql: "DROP TABLE events" });
  assert.equal(asTool.error?.kind, "invalid_input");
  assert.equal(asTool.calls.length, 0);
  const manifest = buildManifest(pluginDefinition);
  assert.equal(manifest.tools.some((tool) => tool.name === "execute"), false);
  assert.equal(manifest.tools.some((tool) => tool.name === "api_request"), false);
});

test("CLICKHOUSE_URL defaults to http://localhost:8123; remote http and URLs with a query are refused", async () => {
  const local = await run("ping", {}, { environment: { CLICKHOUSE_URL: "" }, responses: [{ body: "Ok.\n", headers: { "content-type": "text/plain" } }] });
  assert.equal(local.calls[0].url, "http://localhost:8123/ping");
  for (const badUrl of ["http://ch.example.com:8123", "https://ch.example.com/?readonly=0", "https://user:pw@ch.example.com"]) {
    const { error, calls } = await run("ping", {}, { environment: { CLICKHOUSE_URL: badUrl } });
    assert.equal(error?.kind, "invalid_input", badUrl);
    assert.equal(calls.length, 0);
  }
  const proxied = await run("ping", {}, { environment: { CLICKHOUSE_URL: "https://proxy.example.com/clickhouse/" }, responses: [{ body: "Ok.\n" }] });
  assert.equal(proxied.calls[0].url, "https://proxy.example.com/clickhouse/ping");
});

test("tool query results are truncated, node results are not", async () => {
  const bigResult = { meta: [], data: Array.from({ length: 5000 }, (_, index) => ({ row: index, filler: "x".repeat(40) })), rows: 5000 };
  const tool = await run("query", { sql: "SELECT 1" }, { responses: [{ body: bigResult }] });
  assert.equal(tool.output.data.truncated, true);
  const node = await run("query", { sql: "SELECT 1" }, { source: "node", responses: [{ body: bigResult }] });
  assert.equal(node.output.data.data.length, 5000);
});
