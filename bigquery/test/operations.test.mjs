import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { clearCachedAccessTokens } from "../lib/google-auth.mjs";
import { decodeResultsCursor, encodeResultsCursor } from "../lib/query-results.mjs";
import { pluginDefinition } from "../definition.mjs";

const BASE = "https://bigquery.googleapis.com/bigquery/v2";
const ENVIRONMENT = { GOOGLE_ACCESS_TOKEN: "google-access-token-value", BIGQUERY_PROJECT_ID: "my-project" };
const SELECT_DRY_RUN = { body: { statistics: { totalBytesProcessed: "1000", query: { statementType: "SELECT", schema: { fields: [{ name: "n", type: "INTEGER" }] }, referencedTables: [{ projectId: "my-project", datasetId: "shop", tableId: "orders" }] } } } };
const QUERY_RESPONSE = {
  body: {
    jobComplete: true,
    jobReference: { projectId: "my-project", jobId: "job_1", location: "US" },
    schema: { fields: [{ name: "n", type: "INTEGER" }, { name: "name", type: "STRING" }] },
    rows: [{ f: [{ v: "1" }, { v: "a" }] }, { f: [{ v: "2" }, { v: "b" }] }],
    totalRows: "5",
    totalBytesProcessed: "1000",
    totalBytesBilled: "10485760",
    cacheHit: false,
  },
};

async function runBigQuery(operationName, args, { responses = [{ body: {} }], environment = ENVIRONMENT, source = "node" } = {}) {
  clearCachedAccessTokens();
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  try {
    return { output: await runOperation(operationName, args, { source }), calls: recordingFetch.calls };
  } catch (error) {
    return { error, calls: recordingFetch.calls };
  }
}

// Replays `responses`, then hangs every later request until its signal aborts (cancel requests answer at once).
function createHangingFetch(responses) {
  const recordingFetch = createRecordingFetch(responses);
  let remaining = responses.length;
  const hangingFetch = async (url, init = {}) => {
    if (remaining > 0 || String(url).includes("/cancel")) {
      remaining -= 1;
      return recordingFetch(url, init);
    }
    recordingFetch.calls.push({ url: String(url), method: init.method ?? "GET" });
    return new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("not aborted")), 2000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(init.signal.reason);
      });
    });
  };
  hangingFetch.calls = recordingFetch.calls;
  return hangingFetch;
}

async function runBigQueryWithFetch(operationName, args, fetchImpl, { signal, source = "node" } = {}) {
  clearCachedAccessTokens();
  const runOperation = createOperationRunner(pluginDefinition, ENVIRONMENT, { fetchImpl });
  try {
    return { output: await runOperation(operationName, args, { source, signal }) };
  } catch (error) {
    return { error };
  }
}

test("Google auth files are byte-identical to google-sheets/lib", { skip: existsSync(fileURLToPath(new URL("../../google-sheets/lib", import.meta.url))) ? false : "google-sheets not next to this plugin" }, () => {
  for (const fileName of ["google-auth.mjs", "google-errors.mjs", "google-token-endpoint.mjs", "service-account.mjs"]) {
    const ownCopy = readFileSync(new URL(`../lib/${fileName}`, import.meta.url));
    const original = readFileSync(new URL(`../../google-sheets/lib/${fileName}`, import.meta.url));
    assert.ok(ownCopy.equals(original), `copy google-sheets/lib/${fileName} over bigquery/lib/${fileName}`);
  }
});

// operation, args -> method, path, query subset
const CATALOG_CASES = [
  ["list_datasets", { limit: 10, cursor: "p2", filter: "labels.env:prod" }, "GET", "/projects/my-project/datasets", { maxResults: "10", pageToken: "p2", filter: "labels.env:prod" }],
  ["list_datasets", { project_id: "example.com:other-proj" }, "GET", "/projects/example.com%3Aother-proj/datasets", { maxResults: "100" }],
  ["list_tables", { dataset_id: "shop" }, "GET", "/projects/my-project/datasets/shop/tables", { maxResults: "100" }],
  ["get_table", { dataset_id: "shop", table_id: "orders/2026" }, "GET", "/projects/my-project/datasets/shop/tables/orders%2F2026", {}],
];

for (const [operationName, args, method, path, query] of CATALOG_CASES) {
  test(`${operationName} ${JSON.stringify(args)} calls ${path}`, async () => {
    const { calls, error } = await runBigQuery(operationName, args);
    assert.equal(error, undefined, error?.message);
    assert.equal(calls[0].method, method);
    assert.equal(calls[0].url.split("?")[0], `${BASE}${path}`);
    assert.deepEqual(calls[0].query, query);
    assert.equal(calls[0].headers.authorization, "Bearer google-access-token-value");
  });
}

test("get_table summarizes the schema and sizes", async () => {
  const table = { tableReference: { tableId: "orders", datasetId: "shop" }, type: "TABLE", numRows: "12", numBytes: "2048", creationTime: "1767225600000", schema: { fields: [{ name: "id", type: "INTEGER", mode: "REQUIRED" }] }, timePartitioning: { type: "DAY", field: "created" } };
  const { output } = await runBigQuery("get_table", { dataset_id: "shop", table_id: "orders" }, { responses: [{ body: table }] });
  assert.equal(output.data.num_rows, 12);
  assert.equal(output.data.created_at, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(output.data.schema, [{ name: "id", type: "INTEGER", mode: "REQUIRED", description: null }]);
  assert.deepEqual(output.data.partitioning, { type: "DAY", field: "created" });
});

const INSERTED = { body: { jobReference: { projectId: "my-project", jobId: "ignored", location: "US" }, status: { state: "RUNNING" } } };
const JOB_ID_PATTERN = /^graphrt_[0-9a-f_]{36}$/;

test("a node query inserts a job with its own id and the cap, then reads results with int64 timestamps", async () => {
  const { output, calls } = await runBigQuery("query", { sql: "SELECT n, name FROM shop.t WHERE d >= @since", params: { since: { type: "DATE", value: "2026-11-01" } }, max_rows: 2, location: "US", labels: { team: "ops" } }, { responses: [INSERTED, QUERY_RESPONSE] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${BASE}/projects/my-project/jobs`);
  const { jobReference, configuration } = calls[0].json;
  assert.match(jobReference.jobId, JOB_ID_PATTERN);
  assert.deepEqual({ projectId: jobReference.projectId, location: jobReference.location }, { projectId: "my-project", location: "US" });
  assert.equal(configuration.query.query, "SELECT n, name FROM shop.t WHERE d >= @since");
  assert.equal(configuration.query.useLegacySql, false);
  assert.equal(configuration.query.maximumBytesBilled, String(1024 ** 3));
  assert.deepEqual(configuration.query.queryParameters, [{ name: "since", parameterType: { type: "DATE" }, parameterValue: { value: "2026-11-01" } }]);
  assert.deepEqual(configuration.labels, { team: "ops" });
  assert.equal(configuration.dryRun, undefined);
  assert.equal(calls[1].url.split("?")[0], `${BASE}/projects/my-project/queries/${jobReference.jobId}`);
  assert.deepEqual(calls[1].query, { location: "US", maxResults: "2", timeoutMs: "30000", "formatOptions.useInt64Timestamp": "true" });
  assert.deepEqual(output.data.rows, [{ n: 1, name: "a" }, { n: 2, name: "b" }]);
  assert.equal(output.data.job_id, jobReference.jobId);
  assert.equal(output.data.total_rows, 5);
  assert.deepEqual(decodeResultsCursor(output.next_cursor), { projectId: "my-project", jobId: jobReference.jobId, location: "US", startIndex: 2 });
});

test("a job insert retried after an unknown outcome treats 409 Already Exists as submitted", async () => {
  const unavailable = { status: 503, body: { error: { code: 503, status: "UNAVAILABLE", message: "backend error" } } };
  const duplicate = { status: 409, body: { error: { code: 409, status: "ALREADY_EXISTS", message: "Already Exists: Job my-project:US.graphrt_x" } } };
  const { output, calls, error } = await runBigQuery("query", { sql: "SELECT 1" }, { responses: [unavailable, duplicate, QUERY_RESPONSE] });
  assert.equal(error, undefined, error?.message);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].json.jobReference.jobId, calls[0].json.jobReference.jobId);
  assert.equal(output.data.rows.length, 2);
});

test("params given as JSON text (templates) and positional arrays both work", async () => {
  const fromText = await runBigQuery("query", { sql: "SELECT @a", params: '{"a": 1}' }, { responses: [INSERTED, QUERY_RESPONSE] });
  assert.equal(fromText.calls[0].json.configuration.query.parameterMode, "NAMED");
  const positional = await runBigQuery("query", { sql: "SELECT ?", params: [true] }, { responses: [INSERTED, QUERY_RESPONSE] });
  assert.deepEqual(positional.calls[0].json.configuration.query.queryParameters, [{ parameterType: { type: "BOOL" }, parameterValue: { value: "true" } }]);
  const bad = await runBigQuery("query", { sql: "SELECT 1", params: "{not json" });
  assert.equal(bad.error.kind, "invalid_input");
});

test("maximum_bytes_billed may lower the cap but never exceed BIGQUERY_MAX_BYTES_BILLED", async () => {
  const lowered = await runBigQuery("query", { sql: "SELECT 1", maximum_bytes_billed: 5000 }, { responses: [INSERTED, QUERY_RESPONSE] });
  assert.equal(lowered.calls[0].json.configuration.query.maximumBytesBilled, "5000");
  const above = await runBigQuery("query", { sql: "SELECT 1", maximum_bytes_billed: 2 * 1024 ** 3 });
  assert.equal(above.error.kind, "invalid_input");
  assert.equal(above.calls.length, 0);
  const configured = await runBigQuery("query", { sql: "SELECT 1" }, { responses: [INSERTED, QUERY_RESPONSE], environment: { ...ENVIRONMENT, BIGQUERY_MAX_BYTES_BILLED: "100000000" } });
  assert.equal(configured.calls[0].json.configuration.query.maximumBytesBilled, "100000000");
  const invalid = await runBigQuery("query", { sql: "SELECT 1" }, { environment: { ...ENVIRONMENT, BIGQUERY_MAX_BYTES_BILLED: "0" } });
  assert.equal(invalid.error.kind, "invalid_input");
});

test("dry_run uses a dry-run job and returns statement type and bytes, without running the query", async () => {
  const { output, calls } = await runBigQuery("query", { sql: "SELECT n FROM shop.orders", dry_run: true }, { responses: [SELECT_DRY_RUN] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/projects/my-project/jobs`);
  assert.equal(calls[0].json.configuration.dryRun, true);
  assert.equal(calls[0].json.configuration.query.maximumBytesBilled, String(1024 ** 3));
  assert.deepEqual(output.data, { dry_run: true, statement_type: "SELECT", total_bytes_processed: 1000, maximum_bytes_billed: 1024 ** 3, within_limit: true, schema: [{ name: "n", type: "INTEGER", mode: "NULLABLE", description: null }], referenced_tables: ["my-project.shop.orders"] });
});

test("agent tools: a dry run checks the statement type first; only SELECT runs without the opt-in", async () => {
  const select = await runBigQuery("query", { sql: "SELECT 1" }, { source: "tool", responses: [SELECT_DRY_RUN, INSERTED, QUERY_RESPONSE] });
  assert.equal(select.calls.length, 3);
  assert.equal(select.calls[0].json.configuration.dryRun, true);
  assert.equal(select.calls[1].json.configuration.dryRun, undefined);
  for (const statementType of ["INSERT", "DELETE", "CREATE_TABLE", "DROP_TABLE", "SCRIPT", "MERGE", "EXPORT_DATA"]) {
    const dryRun = { body: { statistics: { totalBytesProcessed: "0", query: { statementType } } } };
    const { error, calls } = await runBigQuery("query", { sql: "whatever" }, { source: "tool", responses: [dryRun] });
    assert.equal(error.kind, "permission_denied", statementType);
    assert.match(error.message, /BIGQUERY_TOOL_ALLOW_WRITES=1/);
    assert.equal(calls.length, 1);
  }
  const optedIn = await runBigQuery("query", { sql: "DELETE FROM t WHERE true" }, { source: "tool", responses: [INSERTED, QUERY_RESPONSE], environment: { ...ENVIRONMENT, BIGQUERY_TOOL_ALLOW_WRITES: "1" } });
  assert.equal(optedIn.calls.length, 2);
  const tooBig = { body: { statistics: { totalBytesProcessed: String(2 * 1024 ** 3), query: { statementType: "SELECT" } } } };
  const refused = await runBigQuery("query", { sql: "SELECT * FROM huge" }, { source: "tool", responses: [tooBig] });
  assert.equal(refused.error.kind, "invalid_input");
  assert.equal(refused.calls.length, 1);
});

test("the shared tool access_token is never taken from tool arguments", async () => {
  const { calls } = await runBigQuery("list_datasets", { access_token: "evil" }, { source: "tool" });
  assert.equal(calls[0].headers.authorization, "Bearer google-access-token-value");
});

test("get_query_results pages with startIndex and waits for unfinished jobs", async () => {
  const cursor = encodeResultsCursor({ projectId: "my-project", jobId: "job_1", location: "US", startIndex: 2 });
  const lastPage = { body: { ...QUERY_RESPONSE.body, rows: [{ f: [{ v: "3" }, { v: "c" }] }, { f: [{ v: "4" }, { v: "d" }] }, { f: [{ v: "5" }, { v: "e" }] }] } };
  const { output, calls } = await runBigQuery("get_query_results", { cursor, max_rows: 3, wait_ms: 5000 }, { responses: [lastPage] });
  assert.equal(calls[0].url.split("?")[0], `${BASE}/projects/my-project/queries/job_1`);
  assert.deepEqual(calls[0].query, { location: "US", startIndex: "2", maxResults: "3", timeoutMs: "5000", "formatOptions.useInt64Timestamp": "true" });
  assert.equal(output.data.rows.length, 3);
  assert.equal(output.next_cursor, null);
  const running = await runBigQuery("query", { sql: "SELECT 1" }, { responses: [{ body: { ...INSERTED.body, jobReference: { projectId: "my-project", jobId: "x", location: "EU" } } }, { body: { jobComplete: false } }] });
  assert.equal(running.output.data.job_complete, false);
  const runningPosition = decodeResultsCursor(running.output.next_cursor);
  assert.match(runningPosition.jobId, JOB_ID_PATTERN);
  assert.deepEqual({ ...runningPosition, jobId: "id" }, { projectId: "my-project", jobId: "id", location: "EU", startIndex: 0 });
  const tampered = await runBigQuery("get_query_results", { cursor: Buffer.from(JSON.stringify({ p: "my-project", j: "../x", s: 0 })).toString("base64url") });
  assert.equal(tampered.error.kind, "invalid_input");
  assert.equal(tampered.calls.length, 0);
});

test("aborting a query or a results wait cancels the job in the background", async () => {
  const controller = new AbortController();
  const hangingFetch = createHangingFetch([INSERTED]);
  const pending = runBigQueryWithFetch("query", { sql: "SELECT 1" }, hangingFetch, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const { error } = await pending;
  assert.equal(error.kind, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const jobId = hangingFetch.calls[0].json.jobReference.jobId;
  assert.ok(hangingFetch.calls.some((call) => call.method === "POST" && call.url === `${BASE}/projects/my-project/jobs/${jobId}/cancel?location=US`), JSON.stringify(hangingFetch.calls.map((call) => call.url)));
  const resultsController = new AbortController();
  const resultsFetch = createHangingFetch([]);
  const cursor = encodeResultsCursor({ projectId: "my-project", jobId: "job_9", location: "EU", startIndex: 0 });
  const waiting = runBigQueryWithFetch("get_query_results", { cursor }, resultsFetch, { signal: resultsController.signal });
  setTimeout(() => resultsController.abort(), 30);
  assert.equal((await waiting).error.kind, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(resultsFetch.calls.some((call) => call.url === `${BASE}/projects/my-project/jobs/job_9/cancel?location=EU`));
});

test("agent tools may only read results of jobs an agent tool call started in this process", async () => {
  const foreign = encodeResultsCursor({ projectId: "my-project", jobId: "node_job", location: "US", startIndex: 0 });
  const refused = await runBigQuery("get_query_results", { cursor: foreign }, { source: "tool" });
  assert.equal(refused.error.kind, "permission_denied");
  assert.equal(refused.calls.length, 0);
  const node = await runBigQuery("get_query_results", { cursor: foreign }, { responses: [QUERY_RESPONSE] });
  assert.equal(node.error, undefined);
  const started = await runBigQuery("query", { sql: "SELECT 1", max_rows: 1 }, { source: "tool", responses: [SELECT_DRY_RUN, INSERTED, QUERY_RESPONSE] });
  const own = await runBigQuery("get_query_results", { cursor: started.output.next_cursor }, { source: "tool", responses: [QUERY_RESPONSE] });
  assert.equal(own.error, undefined, own.error?.message);
});

test("rows beyond BIGQUERY_MAX_RESULT_BYTES are cut and the cursor resumes at the first cut row", async () => {
  const wideRows = Array.from({ length: 4 }, (_, index) => ({ f: [{ v: String(index) }, { v: "x".repeat(600) }] }));
  const { output } = await runBigQuery("query", { sql: "SELECT 1" }, { responses: [INSERTED, { body: { ...QUERY_RESPONSE.body, rows: wideRows, totalRows: "4" } }], environment: { ...ENVIRONMENT, BIGQUERY_MAX_RESULT_BYTES: "1500" } });
  assert.equal(output.data.rows.length, 2);
  assert.equal(output.data.truncated, true);
  assert.equal(decodeResultsCursor(output.next_cursor).startIndex, 2);
});

test("errors: auth, permission, bytes-billed cap and not found map to kinds; tokens are redacted", async () => {
  const cases = [
    [{ status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED", message: "Invalid Credentials" } } }, "auth_error"],
    [{ status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", message: "Access Denied" } } }, "permission_denied"],
    [{ status: 404, body: { error: { code: 404, status: "NOT_FOUND", message: "Not found: Dataset" } } }, "not_found"],
    [{ status: 400, body: { error: { code: 400, message: "Query exceeded limit for bytes billed: 1000.", errors: [{ reason: "bytesBilledLimitExceeded" }] } } }, "invalid_input"],
  ];
  for (const [response, kind] of cases) {
    const { error } = await runBigQuery("list_datasets", {}, { responses: [response, response] });
    assert.equal(error.kind, kind, JSON.stringify(response));
  }
  const capError = await runBigQuery("query", { sql: "SELECT 1" }, { responses: [INSERTED, cases[3][0]] });
  assert.match(capError.error.message, /BIGQUERY_MAX_BYTES_BILLED/);
  const echoed = await runBigQuery("list_datasets", {}, { responses: [{ status: 400, body: { error: { message: "bad google-access-token-value" } } }] });
  assert.doesNotMatch(echoed.error.message, /google-access-token-value/);
});

test("a service account key file is exchanged for a bigquery-scoped token", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyFilePath = join(mkdtempSync(join(tmpdir(), "bq-sa-")), "key.json");
  writeFileSync(keyFilePath, JSON.stringify({ type: "service_account", client_email: "robot@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }));
  const environment = { GOOGLE_SERVICE_ACCOUNT_JSON: keyFilePath, BIGQUERY_PROJECT_ID: "my-project" };
  const { calls } = await runBigQuery("list_datasets", {}, { environment, responses: [{ body: { access_token: "sa-token", expires_in: 3600 } }, { body: {} }] });
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  const claims = JSON.parse(Buffer.from(calls[0].form.assertion.split(".")[1], "base64url").toString("utf8"));
  assert.equal(claims.scope, "https://www.googleapis.com/auth/bigquery");
  assert.equal(calls[1].headers.authorization, "Bearer sa-token");
});

test("missing project or credentials are clear errors before any request", async () => {
  const noProject = await runBigQuery("list_datasets", {}, { environment: { GOOGLE_ACCESS_TOKEN: "t-value" } });
  assert.equal(noProject.error.kind, "invalid_input");
  assert.match(noProject.error.message, /BIGQUERY_PROJECT_ID/);
  const noCredentials = await runBigQuery("list_datasets", {}, { environment: { BIGQUERY_PROJECT_ID: "my-project" } });
  assert.equal(noCredentials.error.kind, "auth_error");
  assert.equal(noCredentials.calls.length, 0);
});
