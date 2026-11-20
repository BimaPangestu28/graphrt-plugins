import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner, createToolHandler } from "../lib/shared/operations.mjs";
import { toolContext } from "../lib/shared/graphrt-plugin.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const PROJECT = "https://abcdefghijklmnopqrst.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_test_0123456789";
const encodePart = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const USER_JWT = `${encodePart({ alg: "HS256" })}.${encodePart({ sub: "user-1", role: "authenticated" })}.c2lnbmF0dXJl`;
const SERVICE_ROLE_JWT = `${encodePart({ alg: "HS256" })}.${encodePart({ role: "service_role" })}.c2lnbmF0dXJl`;
const USER_RPC_ENV = { SUPABASE_URL: PROJECT, SUPABASE_KEY: PUBLISHABLE_KEY, SUPABASE_TOOL_MODE: "user_rpc", SUPABASE_TOOL_RPC_ALLOWLIST: "get_balance, list_orders" };
const userContext = (userJwt = USER_JWT) => toolContext({ secrets: { user_jwt: userJwt } });

function userRpcRunner(environment, fetchImpl) {
  const toolOperations = pluginDefinition.resolveToolOperations(environment);
  return { toolOperations, runner: createOperationRunner({ ...pluginDefinition, operations: toolOperations }, environment, { fetchImpl }) };
}

async function callAsUser(args, { environment = {}, responses = [{ body: [] }], context = userContext(), fetchImpl } = {}) {
  const recordingFetch = fetchImpl ?? createRecordingFetch(responses);
  const { runner } = userRpcRunner({ ...USER_RPC_ENV, ...environment }, recordingFetch);
  const handler = createToolHandler(runner, "call_function", 60000);
  const outcome = await handler(args, context).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls ?? [] };
}

const assertNoJwt = (value) => assert.ok(!JSON.stringify(value ?? null).includes(USER_JWT) && !String(value?.message ?? "").includes(USER_JWT));

test("user_rpc offers only call_function, without the write opt-in", () => {
  const { toolOperations } = userRpcRunner(USER_RPC_ENV);
  assert.deepEqual(toolOperations.map((operation) => operation.name), ["call_function"]);
  assert.deepEqual(toolOperations[0].parameters.properties.function_name.enum, ["get_balance", "list_orders"]);
  assert.equal(pluginDefinition.resolveToolOperations({}), undefined);
  assert.throws(() => pluginDefinition.resolveToolOperations({ SUPABASE_TOOL_MODE: "admin" }), /SUPABASE_TOOL_MODE/);
});

test("user_rpc sends the publishable key as apikey and the context JWT as Bearer", async () => {
  const { output, calls } = await callAsUser({ function_name: "get_balance", arguments: { currency: "IDR" } }, { responses: [{ body: { balance: 10 } }] });
  assert.deepEqual(output.data.data, { balance: 10 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${PROJECT}/rest/v1/rpc/get_balance`);
  assert.equal(calls[0].headers.apikey, PUBLISHABLE_KEY);
  assert.equal(calls[0].headers.authorization, `Bearer ${USER_JWT}`);
  assert.deepEqual(calls[0].json, { currency: "IDR" });
  assertNoJwt(output);
});

test("a call without a user JWT is refused before any request, never falling back to env credentials", async () => {
  const environment = { SUPABASE_USER_JWT: USER_JWT };
  for (const context of [toolContext(undefined), toolContext({ secrets: { user_jwt: "" } }), toolContext({ secrets: { user_jwt: "******" } }), null]) {
    const { error, calls } = await callAsUser({ function_name: "get_balance" }, { environment, context });
    assert.equal(error?.kind, "auth_error");
    assert.match(error.message, /tool_context\.supabase\.user_jwt/);
    assert.equal(calls.length, 0);
  }
});

test("a service_role token is refused as user JWT and as SUPABASE_KEY", async () => {
  const asUser = await callAsUser({ function_name: "get_balance" }, { context: userContext(SERVICE_ROLE_JWT) });
  assert.equal(asUser.error?.kind, "auth_error");
  for (const key of ["sb_secret_test_0123456789", SERVICE_ROLE_JWT]) {
    const asKey = await callAsUser({ function_name: "get_balance" }, { environment: { SUPABASE_KEY: key } });
    assert.equal(asKey.error?.kind, "auth_error");
    assert.match(asKey.error.message, /publishable/);
    assert.equal(asUser.calls.length + asKey.calls.length, 0);
  }
});

test("functions outside the allowlist are refused, also when the model is talked into one", async () => {
  for (const functionName of ["delete_all_users", "get_balance; drop table orders", "../auth/v1/admin/users", "GET_BALANCE2"]) {
    const { error, calls } = await callAsUser({ function_name: functionName });
    assert.ok(["permission_denied", "invalid_input"].includes(error?.kind), functionName);
    assert.match(error.message, /get_balance, list_orders/);
    assert.equal(calls.length, 0);
  }
});

test("user_rpc without SUPABASE_TOOL_RPC_ALLOWLIST refuses every call", async () => {
  const { error, calls } = await callAsUser({ function_name: "get_balance" }, { environment: { SUPABASE_TOOL_RPC_ALLOWLIST: "" } });
  assert.equal(error?.kind, "permission_denied");
  assert.match(error.message, /SUPABASE_TOOL_RPC_ALLOWLIST/);
  assert.equal(calls.length, 0);
});

test("array results are cut to SUPABASE_TOOL_MAX_ROWS with a note", async () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ id: index }));
  const { output } = await callAsUser({ function_name: "list_orders" }, { environment: { SUPABASE_TOOL_MAX_ROWS: "5" }, responses: [{ body: rows }] });
  assert.equal(output.data.data.items.length, 5);
  assert.equal(output.data.data.total_items, 12);
  assert.equal(output.data.data.truncated, true);
  assert.match(output.data.data.note, /first 5 of 12 rows/);
  const small = await callAsUser({ function_name: "list_orders" }, { responses: [{ body: rows }] });
  assert.equal(small.output.data.data.length, 12);
});

test("a slow function fails with a timeout error naming SUPABASE_TOOL_TIMEOUT_MS", async () => {
  // AbortSignal.timeout does not keep the event loop alive (stdin does in a real plugin), so this fetch does.
  const hangingFetch = (url, init) =>
    new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("the timeout never fired")), 10000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(init.signal.reason);
      }, { once: true });
    });
  const startedAt = Date.now();
  const { error } = await callAsUser({ function_name: "get_balance" }, { environment: { SUPABASE_TOOL_TIMEOUT_MS: "1000" }, fetchImpl: hangingFetch });
  assert.equal(error?.kind, "timeout");
  assert.match(error.message, /1000 ms \(SUPABASE_TOOL_TIMEOUT_MS\)/);
  assert.ok(Date.now() - startedAt < 5000);
  assertNoJwt(error);
});

test("the user JWT never appears in results or errors, even when the API echoes it", async () => {
  const echoed = await callAsUser({ function_name: "get_balance" }, { responses: [{ body: { token: USER_JWT, note: `Bearer ${USER_JWT}` } }] });
  assertNoJwt(echoed.output);
  const failed = await callAsUser({ function_name: "get_balance" }, { responses: [{ status: 401, body: { code: "PGRST301", message: `JWT ${USER_JWT} expired` } }] });
  assert.equal(failed.error?.kind, "auth_error");
  assertNoJwt(failed.error);
});

test("bad tool settings are reported, naming the variable", async () => {
  for (const [envName, value] of [["SUPABASE_TOOL_TIMEOUT_MS", "fast"], ["SUPABASE_TOOL_MAX_ROWS", "0"], ["SUPABASE_TOOL_RPC_ALLOWLIST", "ok,bad name"]]) {
    const { error, calls } = await callAsUser({ function_name: "get_balance" }, { environment: { [envName]: value } });
    assert.match(error?.message ?? "", new RegExp(envName), envName);
    assert.equal(calls.length, 0);
  }
});

test("default mode: the call_function tool follows the allowlist and row cap but still needs the write opt-in", async () => {
  const environment = { SUPABASE_URL: PROJECT, SUPABASE_KEY: "sb_secret_test_0123456789", SUPABASE_TOOL_ALLOW_WRITES: "1", SUPABASE_TOOL_RPC_ALLOWLIST: "get_balance", SUPABASE_TOOL_MAX_ROWS: "2" };
  const recordingFetch = createRecordingFetch([{ body: [{ id: 1 }, { id: 2 }, { id: 3 }] }]);
  const runner = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const refused = await runner("call_function", { function_name: "drop_everything" }, { source: "tool" }).catch((error) => error);
  assert.equal(refused.kind, "permission_denied");
  const allowed = await runner("call_function", { function_name: "get_balance" }, { source: "tool" });
  assert.equal(allowed.data.items.length, 2);
  assert.equal(recordingFetch.calls.length, 1);
  const withoutOptIn = createOperationRunner(pluginDefinition, { ...environment, SUPABASE_TOOL_ALLOW_WRITES: "" }, { fetchImpl: recordingFetch });
  assert.equal((await withoutOptIn("call_function", { function_name: "get_balance" }, { source: "tool" }).catch((error) => error)).kind, "permission_denied");
});
