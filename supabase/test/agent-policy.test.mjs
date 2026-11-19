import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const PROJECT = "https://abcdefghijklmnopqrst.supabase.co";
const SECRET_KEY = "sb_secret_test_0123456789";
const LEGACY_KEY = "eyJhbGciOiJIUzI1NiJ9.legacy.signature";

async function run(operationName, args, { source = "tool", environment = {}, responses = [{ body: [] }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { SUPABASE_URL: PROJECT, SUPABASE_KEY: SECRET_KEY, ...environment }, { fetchImpl: recordingFetch });
  const outcome = await runner(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("update_rows and delete_rows without a filter are refused before any request, also for nodes", async () => {
  for (const [operationName, args] of [["update_rows", { table: "todos", values: { done: true }, filters: [] }], ["delete_rows", { table: "todos" }]]) {
    const { error, calls } = await run(operationName, args, { source: "node" });
    assert.equal(error?.kind, "invalid_input", operationName);
    assert.equal(calls.length, 0);
  }
});

test("a filter value that tries to add conditions stays one quoted value", async () => {
  const { calls } = await run("select_rows", { table: "todos", filters: [{ column: "owner", operator: "eq", value: "me\"),or(id.gt.0" }] });
  assert.equal(calls[0].query.and, '(owner.eq."me\\"),or(id.gt.0")');
  assert.deepEqual(Object.keys(calls[0].query).sort(), ["and", "limit"]);
});

test("bad filter columns and order values are refused before any request", async () => {
  const badColumn = await run("select_rows", { table: "todos", filters: [{ column: "id&select=secret", operator: "eq", value: 1 }] });
  assert.equal(badColumn.error?.kind, "invalid_input");
  const badOrder = await run("select_rows", { table: "todos", order: "id;select=x" });
  assert.equal(badOrder.error?.kind, "invalid_input");
  assert.equal(badColumn.calls.length + badOrder.calls.length, 0);
});

test("tools write only with SUPABASE_TOOL_ALLOW_WRITES=1", async () => {
  const refused = await run("insert_rows", { table: "todos", rows: [{ title: "x" }] });
  assert.equal(refused.error?.kind, "permission_denied");
  assert.match(refused.error.message, /SUPABASE_TOOL_ALLOW_WRITES/);
  const allowed = await run("insert_rows", { table: "todos", rows: [{ title: "x" }] }, { environment: { SUPABASE_TOOL_ALLOW_WRITES: "1" } });
  assert.equal(allowed.error, undefined);
  assert.equal(allowed.calls[0].method, "POST");
});

test("upsert_rows merges duplicates by default", async () => {
  const { calls } = await run("upsert_rows", { table: "t", rows: [{ id: 1 }] }, { source: "node" });
  assert.equal(calls[0].headers.prefer, "resolution=merge-duplicates,return=representation,missing=default");
});

test("tool uploads may not overwrite (upsert), workflow nodes may", async () => {
  const environment = { SUPABASE_TOOL_ALLOW_WRITES: "1" };
  const args = { bucket_id: "docs", object_path: "a.txt", file: "https://files.example.com/a.txt", upsert: true };
  const refused = await run("upload_object", args, { environment });
  assert.equal(refused.error?.kind, "permission_denied");
  assert.match(refused.error.message, /overwrite/);
  assert.equal(refused.calls.length, 0);
});

test("api_request as a tool only reaches Data API and Storage reads", async () => {
  for (const path of ["/auth/v1/admin/users", "/functions/v1/send-email", "/rest/v1/../auth/v1/admin/users", "/rest/v1/%2e%2e/auth/v1/admin/users", "/graphql/v1"]) {
    const { error, calls } = await run("api_request", { method: "GET", path });
    assert.equal(error?.kind, "permission_denied", path);
    assert.equal(calls.length, 0);
  }
  const allowed = await run("api_request", { method: "GET", path: "/rest/v1/todos?select=id&id=eq.1" });
  assert.equal(allowed.error, undefined);
  assert.equal(allowed.calls.length, 1);
});

test("new keys go only in apikey; legacy JWT keys also as Bearer; SUPABASE_USER_JWT is the Bearer and redacted", async () => {
  const newKey = await run("list_buckets", {});
  assert.equal(newKey.calls[0].headers.apikey, SECRET_KEY);
  assert.equal(newKey.calls[0].headers.authorization, undefined);
  const legacy = await run("list_buckets", {}, { environment: { SUPABASE_KEY: LEGACY_KEY } });
  assert.equal(legacy.calls[0].headers.authorization, `Bearer ${LEGACY_KEY}`);
  const userJwt = "eyJ.user-session-token.sig";
  const asUser = await run("list_buckets", {}, { environment: { SUPABASE_KEY: LEGACY_KEY, SUPABASE_USER_JWT: userJwt }, responses: [{ body: [{ echo: userJwt }] }] });
  assert.equal(asUser.calls[0].headers.authorization, `Bearer ${userJwt}`);
  assert.equal(JSON.stringify(asUser.output).includes(userJwt), false);
});

test("SUPABASE_URL must be an https project origin (http only on localhost)", async () => {
  for (const badUrl of ["", "http://abc.supabase.co", "https://abc.supabase.co/rest/v1", "https://abc.supabase.co?x=1", "https://a.b.supabase.co"]) {
    const { error, calls } = await run("list_buckets", {}, { environment: { SUPABASE_URL: badUrl } });
    assert.equal(error?.kind, "invalid_input", badUrl);
    assert.equal(calls.length, 0);
  }
  const local = await run("list_buckets", {}, { environment: { SUPABASE_URL: "http://127.0.0.1:54321" } });
  assert.equal(local.calls[0].url, "http://127.0.0.1:54321/storage/v1/bucket");
  const custom = await run("list_buckets", {}, { environment: { SUPABASE_URL: "https://api.example.com/" } });
  assert.equal(custom.calls[0].url, "https://api.example.com/storage/v1/bucket");
});

test("gateway and PostgREST auth failures are auth_error; missing tables are not_found", async () => {
  const invalidKey = await run("list_buckets", {}, { responses: [{ status: 401, body: { message: "Invalid API key", hint: "Double check your Supabase `anon` or `service_role` API key." } }] });
  assert.equal(invalidKey.error?.kind, "auth_error");
  assert.match(invalidKey.error.message, /Invalid API key/);
  const expired = await run("select_rows", { table: "t" }, { responses: [{ status: 400, body: { code: "PGRST301", message: "JWT expired" } }] });
  assert.equal(expired.error?.kind, "auth_error");
  const missing = await run("select_rows", { table: "nope" }, { responses: [{ status: 400, body: { code: "PGRST205", message: "Could not find the table 'public.nope' in the schema cache" } }] });
  assert.equal(missing.error?.kind, "not_found");
});
