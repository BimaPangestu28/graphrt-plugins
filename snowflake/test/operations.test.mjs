import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { decodeResultsCursor, encodeResultsCursor } from "../lib/statement-results.mjs";
import { createPluginDefinition } from "../definition.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ENCRYPTED_PEM = privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "key-passphrase-value" });
const PLAIN_PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const HANDLE = "01b2c3d4-0000-1111-2222-333344445555";
const BASE = "https://myorg-myaccount.snowflakecomputing.com/api/v2/statements";
const ENVIRONMENT = {
  SNOWFLAKE_ACCOUNT: "myorg-myaccount",
  SNOWFLAKE_USER: "graphrt_user",
  SNOWFLAKE_PRIVATE_KEY_PATH: "/keys/rsa_key.p8",
  SNOWFLAKE_PRIVATE_KEY_PASSPHRASE: "key-passphrase-value",
  SNOWFLAKE_WAREHOUSE: "REPORTING_WH",
  SNOWFLAKE_DATABASE: "ANALYTICS",
  SNOWFLAKE_ROLE: "ETL_ROLE",
  SNOWFLAKE_TOOL_ROLE: "AGENT_READER",
  GRAPHRT_POLL_INTERVAL_MS: "0",
};
const RESULT_SET = {
  statementHandle: HANDLE,
  message: "Statement executed successfully.",
  resultSetMetaData: { numRows: 3, rowType: [{ name: "ID", type: "fixed", scale: 0 }, { name: "NAME", type: "text" }], partitionInfo: [{ rowCount: 2 }, { rowCount: 1 }] },
  data: [["1", "a"], ["2", "b"]],
};
const ACCEPTED = { status: 202, body: { code: "333334", message: "Asynchronous execution in progress.", statementHandle: HANDLE } };

async function runSnowflake(operationName, args, { responses = [{ body: RESULT_SET }], environment = ENVIRONMENT, source = "node", signal, readFileImpl = async () => ENCRYPTED_PEM, nowMs = Date.UTC(2026, 10, 19, 10) } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const definition = createPluginDefinition({ readFileImpl, now: () => nowMs });
  const runOperation = createOperationRunner(definition, environment, { fetchImpl: recordingFetch });
  try {
    return { output: await runOperation(operationName, args, { source, signal }), calls: recordingFetch.calls };
  } catch (error) {
    return { error, calls: recordingFetch.calls };
  }
}

test("execute submits asynchronously with a key-pair JWT, bindings, defaults and MULTI_STATEMENT_COUNT=1", async () => {
  const { output, calls, error } = await runSnowflake("execute", { statement: "SELECT id, name FROM t WHERE status = ? AND n > ?", bindings: ["open", 5], max_rows: 10 }, { responses: [ACCEPTED, { body: RESULT_SET }] });
  assert.equal(error, undefined, error?.message);
  assert.equal(calls.length, 2);
  const submit = calls[0];
  assert.equal(submit.method, "POST");
  assert.equal(submit.url.split("?")[0], BASE);
  assert.equal(submit.query.async, "true");
  assert.match(submit.query.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(submit.headers["x-snowflake-authorization-token-type"], "KEYPAIR_JWT");
  const claims = JSON.parse(Buffer.from(submit.headers.authorization.split(" ")[1].split(".")[1], "base64url"));
  assert.equal(claims.sub, "MYORG-MYACCOUNT.GRAPHRT_USER");
  assert.deepEqual(submit.json, {
    statement: "SELECT id, name FROM t WHERE status = ? AND n > ?",
    timeout: 60,
    database: "ANALYTICS",
    warehouse: "REPORTING_WH",
    role: "ETL_ROLE",
    bindings: { 1: { type: "TEXT", value: "open" }, 2: { type: "FIXED", value: "5" } },
    parameters: { MULTI_STATEMENT_COUNT: "1", QUERY_TAG: "graphrt" },
  });
  assert.equal(calls[1].method, "GET");
  assert.equal(calls[1].url, `${BASE}/${HANDLE}`);
  assert.deepEqual(output.data.rows, [{ ID: 1, NAME: "a" }, { ID: 2, NAME: "b" }]);
  assert.equal(output.data.total_rows, 3);
  assert.deepEqual(decodeResultsCursor(output.next_cursor), { handle: HANDLE, partition: 1, offset: 0 });
});

test("agent tools: read-only statements run with SNOWFLAKE_TOOL_ROLE and capped timeout; others are refused before any request", async () => {
  const allowed = await runSnowflake("execute", { statement: "SELECT 1", timeout_seconds: 3000 }, { source: "tool", responses: [{ body: RESULT_SET }] });
  assert.equal(allowed.calls[0].json.role, "AGENT_READER");
  assert.equal(allowed.calls[0].json.timeout, 60);
  for (const statement of ["DELETE FROM t", "SELECT 1; DROP TABLE t", "CALL p()", "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x"]) {
    const { error, calls } = await runSnowflake("execute", { statement }, { source: "tool" });
    assert.equal(error.kind, "permission_denied", statement);
    assert.match(error.message, /SNOWFLAKE_TOOL_ALLOW_WRITES=1/);
    assert.equal(calls.length, 0);
  }
  const chooseRole = await runSnowflake("execute", { statement: "SELECT 1", role: "ACCOUNTADMIN" }, { source: "tool" });
  assert.equal(chooseRole.error.kind, "permission_denied");
  const optedIn = await runSnowflake("execute", { statement: "DELETE FROM t" }, { source: "tool", environment: { ...ENVIRONMENT, SNOWFLAKE_TOOL_ALLOW_WRITES: "1" } });
  assert.equal(optedIn.error, undefined);
  assert.equal(optedIn.calls[0].json.role, "AGENT_READER");
});

test("nodes may run writes; a write is not retried after a 5xx and names how to check", async () => {
  const serverError = { status: 503, body: { message: "Service unavailable" } };
  const { error, calls } = await runSnowflake("execute", { statement: "INSERT INTO t VALUES (1)" }, { responses: [serverError, serverError, serverError] });
  assert.equal(calls.length, 1);
  assert.equal(error.retryable, false);
  assert.match(error.message, /outcome unknown.*request id [0-9a-f-]{36}/);
  const readRetried = await runSnowflake("execute", { statement: "SELECT 1" }, { responses: [serverError, { body: RESULT_SET }] });
  assert.equal(readRetried.calls.length, 2);
  assert.equal(readRetried.error, undefined);
});

test("a statement still running after the wait returns its handle; wait false returns at once", async () => {
  const environment = { ...ENVIRONMENT, SNOWFLAKE_WAIT_MS: "1000", GRAPHRT_POLL_INTERVAL_MS: "600" };
  const running = await runSnowflake("execute", { statement: "SELECT 1" }, { responses: [ACCEPTED, ACCEPTED, ACCEPTED], environment });
  assert.deepEqual(running.output.data, { status: "running", statement_handle: HANDLE, note: "Still running: call get_statement_status with this statement_handle" });
  const noWait = await runSnowflake("execute", { statement: "SELECT 1", wait: false }, { responses: [ACCEPTED] });
  assert.equal(noWait.calls.length, 1);
  assert.equal(noWait.output.data.status, "running");
  const status = await runSnowflake("get_statement_status", { statement_handle: HANDLE }, { responses: [ACCEPTED, { body: RESULT_SET }] });
  assert.equal(status.output.data.status, "succeeded");
});

test("aborting a call while it waits cancels the statement", async () => {
  const controller = new AbortController();
  const responses = [ACCEPTED, ACCEPTED, ACCEPTED, ACCEPTED, { body: { message: "cancelled" } }];
  const environment = { ...ENVIRONMENT, GRAPHRT_POLL_INTERVAL_MS: "50" };
  setTimeout(() => controller.abort(), 20);
  const { error, calls } = await runSnowflake("execute", { statement: "SELECT 1" }, { responses, environment, signal: controller.signal });
  assert.equal(error.kind, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(calls.some((call) => call.method === "POST" && call.url === `${BASE}/${HANDLE}/cancel`));
});

test("get_statement_results reads later partitions and resumes inside a partition cut by the byte cap", async () => {
  const cursor = encodeResultsCursor({ handle: HANDLE, partition: 1, offset: 0 });
  const { output, calls } = await runSnowflake("get_statement_results", { cursor }, { responses: [{ body: { data: [["3", "c"]] } }, { body: RESULT_SET }] });
  assert.equal(calls[0].url, `${BASE}/${HANDLE}?partition=1`);
  assert.deepEqual(output.data.rows, [{ ID: 3, NAME: "c" }]);
  assert.equal(output.next_cursor, null);
  const wide = { ...RESULT_SET, data: [["1", "x".repeat(700)], ["2", "y".repeat(700)]] };
  const capped = await runSnowflake("execute", { statement: "SELECT 1" }, { responses: [{ body: wide }], environment: { ...ENVIRONMENT, SNOWFLAKE_MAX_RESULT_BYTES: "1000" } });
  assert.equal(capped.output.data.rows.length, 1);
  assert.deepEqual(decodeResultsCursor(capped.output.next_cursor), { handle: HANDLE, partition: 0, offset: 1 });
  const tampered = await runSnowflake("get_statement_results", { cursor: Buffer.from('{"h":"../x","p":0,"o":0}').toString("base64url") });
  assert.equal(tampered.error.kind, "invalid_input");
  assert.equal(tampered.calls.length, 0);
});

test("cancel_statement posts to the cancel endpoint; bad handles are refused", async () => {
  const { calls } = await runSnowflake("cancel_statement", { statement_handle: HANDLE }, { responses: [{ body: { message: "successfully canceled" } }] });
  assert.equal(calls[0].url, `${BASE}/${HANDLE}/cancel`);
  const bad = await runSnowflake("cancel_statement", { statement_handle: "../../x" });
  assert.equal(bad.error.kind, "invalid_input");
  assert.equal(bad.calls.length, 0);
});

test("errors map to kinds and never contain the JWT, the passphrase or PEM text", async () => {
  const environment = { ...ENVIRONMENT, SNOWFLAKE_PRIVATE_KEY_PATH: undefined, SNOWFLAKE_PRIVATE_KEY: PLAIN_PEM, SNOWFLAKE_PRIVATE_KEY_PASSPHRASE: undefined };
  const cases = [
    [{ status: 401, body: { code: "390144", message: "JWT token is invalid." } }, "auth_error"],
    [{ status: 422, body: { code: "002003", message: "Object 'X' does not exist or not authorized.", sqlState: "02000", statementHandle: HANDLE } }, "not_found"],
    [{ status: 422, body: { code: "001003", message: "SQL compilation error" } }, "invalid_input"],
    [{ status: 429, body: { message: "Too many requests" } }, "rate_limited"],
  ];
  for (const [response, kind] of cases) {
    const { error } = await runSnowflake("execute", { statement: "SELECT 1", wait: false }, { responses: [response, response, response], environment });
    assert.equal(error.kind, kind, JSON.stringify(response));
  }
  const htmlPage = await runSnowflake("execute", { statement: "SELECT 1" }, { responses: [{ status: 404, body: "<!DOCTYPE html><html><title>File not Found</title></html>", headers: { "content-type": "text/html" } }] });
  assert.equal(htmlPage.error.kind, "not_found");
  assert.match(htmlPage.error.message, /check SNOWFLAKE_ACCOUNT/);
  assert.doesNotMatch(htmlPage.error.message, /DOCTYPE/);
  const echo = await runSnowflake("execute", { statement: "SELECT 1" }, { responses: [{ status: 400, body: { message: `echo key-passphrase-value` } }] });
  assert.doesNotMatch(echo.error.message, /key-passphrase-value/);
});

test("key and configuration problems are clear errors before any request", async () => {
  const wrongPassphrase = await runSnowflake("execute", { statement: "SELECT 1" }, { environment: { ...ENVIRONMENT, SNOWFLAKE_PRIVATE_KEY_PASSPHRASE: "bad-passphrase-xyz" } });
  assert.equal(wrongPassphrase.error.kind, "auth_error");
  assert.doesNotMatch(wrongPassphrase.error.message, /BEGIN|bad-passphrase-xyz/);
  assert.equal(wrongPassphrase.calls.length, 0);
  const noKey = await runSnowflake("execute", { statement: "SELECT 1" }, { environment: { SNOWFLAKE_ACCOUNT: "a-b", SNOWFLAKE_USER: "u" } });
  assert.equal(noKey.error.kind, "auth_error");
  const noAccount = await runSnowflake("execute", { statement: "SELECT 1" }, { environment: { SNOWFLAKE_PRIVATE_KEY_PATH: "/k" } });
  assert.equal(noAccount.error.kind, "invalid_input");
  const badHost = await runSnowflake("execute", { statement: "SELECT 1" }, { environment: { ...ENVIRONMENT, SNOWFLAKE_HOST: "evil.example.com" } });
  assert.equal(badHost.error.kind, "invalid_input");
  const badName = await runSnowflake("execute", { statement: "SELECT 1", database: "x; drop" });
  assert.equal(badName.error.kind, "invalid_input");
});

test("a node's access_token is sent as an OAuth token; tools never take one", async () => {
  const node = await runSnowflake("execute", { statement: "SELECT 1", access_token: "oauth-token-value" });
  assert.equal(node.calls[0].headers.authorization, "Bearer oauth-token-value");
  assert.equal(node.calls[0].headers["x-snowflake-authorization-token-type"], "OAUTH");
  const tool = await runSnowflake("execute", { statement: "SELECT 1", access_token: "oauth-token-value" }, { source: "tool" });
  assert.equal(tool.calls[0].headers["x-snowflake-authorization-token-type"], "KEYPAIR_JWT");
});

test("agent tools are refused without SNOWFLAKE_TOOL_ROLE unless SNOWFLAKE_TOOL_ALLOW_WRITES=1", async () => {
  const { SNOWFLAKE_TOOL_ROLE, ...withoutToolRole } = ENVIRONMENT;
  assert.ok(SNOWFLAKE_TOOL_ROLE);
  const refused = await runSnowflake("execute", { statement: "SELECT 1" }, { source: "tool", environment: withoutToolRole });
  assert.equal(refused.error.kind, "permission_denied");
  assert.match(refused.error.message, /SNOWFLAKE_TOOL_ROLE/);
  assert.equal(refused.calls.length, 0);
  const optedIn = await runSnowflake("execute", { statement: "SELECT 1" }, { source: "tool", environment: { ...withoutToolRole, SNOWFLAKE_TOOL_ALLOW_WRITES: "1" } });
  assert.equal(optedIn.error, undefined);
  const node = await runSnowflake("execute", { statement: "SELECT 1" }, { environment: withoutToolRole });
  assert.equal(node.error, undefined);
});

test("agent tools may only read or cancel statement handles a tool call created in this process", async () => {
  const foreignHandle = "0aaaaaaa-0000-1111-2222-333344445555";
  const foreignCursor = encodeResultsCursor({ handle: foreignHandle, partition: 1, offset: 0 });
  for (const [operationName, args] of [
    ["get_statement_status", { statement_handle: foreignHandle }],
    ["get_statement_results", { cursor: foreignCursor }],
    ["cancel_statement", { statement_handle: foreignHandle }],
  ]) {
    const { error, calls } = await runSnowflake(operationName, args, { source: "tool" });
    assert.equal(error.kind, "permission_denied", operationName);
    assert.equal(calls.length, 0);
    const node = await runSnowflake(operationName, args, { responses: [{ body: { ...RESULT_SET, statementHandle: foreignHandle, data: [["3", "c"]] } }, { body: RESULT_SET }] });
    assert.equal(node.error, undefined, `${operationName}: ${node.error?.message}`);
  }
  const ownHandle = "0bbbbbbb-0000-1111-2222-333344445555";
  const started = await runSnowflake("execute", { statement: "SELECT 1", wait: false }, { source: "tool", responses: [{ status: 202, body: { ...ACCEPTED.body, statementHandle: ownHandle } }] });
  assert.equal(started.output.data.statement_handle, ownHandle);
  const status = await runSnowflake("get_statement_status", { statement_handle: ownHandle }, { source: "tool", responses: [{ body: { ...RESULT_SET, statementHandle: ownHandle } }] });
  assert.equal(status.error, undefined);
});

test("the key-pair JWT is cached until five minutes before it expires", async () => {
  let keyReads = 0;
  const readFileImpl = async () => {
    keyReads += 1;
    return ENCRYPTED_PEM;
  };
  const environment = { ...ENVIRONMENT, SNOWFLAKE_PRIVATE_KEY_PATH: "/keys/cache-test.p8" };
  const startMs = Date.UTC(2026, 10, 19, 12);
  const first = await runSnowflake("execute", { statement: "SELECT 1" }, { environment, readFileImpl, nowMs: startMs });
  const second = await runSnowflake("execute", { statement: "SELECT 1" }, { environment, readFileImpl, nowMs: startMs + 50 * 60 * 1000 });
  assert.equal(keyReads, 1);
  assert.equal(second.calls[0].headers.authorization, first.calls[0].headers.authorization);
  const renewed = await runSnowflake("execute", { statement: "SELECT 1" }, { environment, readFileImpl, nowMs: startMs + 55 * 60 * 1000 });
  assert.equal(keyReads, 2);
  assert.notEqual(renewed.calls[0].headers.authorization, first.calls[0].headers.authorization);
});
