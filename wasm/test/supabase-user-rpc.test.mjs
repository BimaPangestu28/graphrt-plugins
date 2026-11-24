/**
 * Behaviour parity of the supabase `call_function` tool in user_rpc mode: every case runs against the Node.js plugin
 * (supabase/, with a recording fetch) and the WebAssembly build (wasm/supabase-rpc, through wasm-host.mjs with the
 * same recorded responses), and both must give the same result, error kind and message, and HTTP requests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createOperationRunner, createToolHandler } from "../../supabase/lib/shared/operations.mjs";
import { toolContext } from "../../supabase/lib/shared/graphrt-plugin.mjs";
import { createRecordingFetch } from "../../supabase/lib/shared/testing.mjs";
import { pluginDefinition } from "../../supabase/definition.mjs";
import { loadWasmPlugin } from "./wasm-host.mjs";

const WASM_PATH = fileURLToPath(new URL("../supabase-rpc/supabase_rpc.wasm", import.meta.url));
const wasmPlugin = loadWasmPlugin(WASM_PATH);

const PROJECT = "https://abcdefghijklmnopqrst.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_test_0123456789";
const encodePart = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const USER_JWT = `${encodePart({ alg: "HS256" })}.${encodePart({ sub: "user-1", role: "authenticated" })}.c2lnbmF0dXJl`;
const SERVICE_ROLE_JWT = `${encodePart({ alg: "HS256" })}.${encodePart({ role: "service_role" })}.c2lnbmF0dXJl`;
const USER_RPC_ENV = { SUPABASE_URL: PROJECT, SUPABASE_KEY: PUBLISHABLE_KEY, SUPABASE_TOOL_MODE: "user_rpc", SUPABASE_TOOL_RPC_ALLOWLIST: "get_balance, list_orders" };
const ROWS = Array.from({ length: 12 }, (_, index) => ({ id: index, label: `row ${index}` }));

/**
 * Shared cases. `secrets: undefined` sends no tool context. `transport` simulates a failed request instead of
 * `responses`: "timeout" (the host's deadline) or "refused". `sameMessage: false` only for transport failures, whose
 * text comes from the HTTP stack (undici vs graphrt-http).
 */
const CASES = [
  { name: "sends the publishable key as apikey and the context JWT as Bearer", args: { function_name: "get_balance", arguments: { currency: "IDR" } }, responses: [{ body: { balance: 10, currency: "IDR" } }] },
  { name: "no tool context", args: { function_name: "get_balance" }, secrets: undefined, environment: { SUPABASE_USER_JWT: USER_JWT }, kind: "auth_error", message: /tool_context\.supabase\.user_jwt/ },
  { name: "empty user JWT", args: { function_name: "get_balance" }, secrets: { user_jwt: "" }, kind: "auth_error" },
  { name: "masked user JWT", args: { function_name: "get_balance" }, secrets: { user_jwt: "******" }, kind: "auth_error" },
  { name: "service_role user JWT", args: { function_name: "get_balance" }, secrets: { user_jwt: SERVICE_ROLE_JWT }, kind: "auth_error", message: /service_role/ },
  { name: "secret key as SUPABASE_KEY", args: { function_name: "get_balance" }, environment: { SUPABASE_KEY: "sb_secret_test_0123456789" }, kind: "auth_error", message: /publishable/ },
  { name: "service_role key as SUPABASE_KEY", args: { function_name: "get_balance" }, environment: { SUPABASE_KEY: SERVICE_ROLE_JWT }, kind: "auth_error", message: /publishable/ },
  { name: "missing SUPABASE_KEY", args: { function_name: "get_balance" }, environment: { SUPABASE_KEY: "" }, kind: "auth_error", message: /SUPABASE_KEY/ },
  ...["delete_all_users", "get_balance; drop table orders", "../auth/v1/admin/users", "GET_BALANCE2"].map((functionName) => ({
    name: `refuses ${functionName}`, args: { function_name: functionName }, kind: "invalid_input", message: /get_balance, list_orders/,
  })),
  { name: "accepts a unique case-insensitive name", args: { function_name: "GET_BALANCE" }, responses: [{ body: 1 }] },
  { name: "arguments as JSON text", args: { function_name: "list_orders", arguments: '{"status": "open"}' }, responses: [{ body: [] }] },
  { name: "arguments that are not an object", args: { function_name: "list_orders", arguments: [1] }, kind: "invalid_input", message: /arguments/ },
  { name: "missing function_name", args: {}, kind: "invalid_input", message: /function_name/ },
  { name: "no allowlist refuses every call", args: { function_name: "get_balance" }, environment: { SUPABASE_TOOL_RPC_ALLOWLIST: "" }, kind: "permission_denied", message: /SUPABASE_TOOL_RPC_ALLOWLIST/ },
  { name: "array results are cut to SUPABASE_TOOL_MAX_ROWS", args: { function_name: "list_orders" }, environment: { SUPABASE_TOOL_MAX_ROWS: "5" }, responses: [{ body: ROWS }] },
  { name: "small array results are whole", args: { function_name: "list_orders" }, responses: [{ body: ROWS }] },
  { name: "huge results become a preview", args: { function_name: "get_balance" }, responses: [{ body: { blob: "é".repeat(60000) + "x".repeat(50000) } }] },
  { name: "a void function (204) returns {}", args: { function_name: "get_balance" }, responses: [{ status: 204 }] },
  { name: "text that is not JSON", args: { function_name: "get_balance" }, responses: [{ body: "plain text" }] },
  { name: "the JWT echoed by the API is redacted", args: { function_name: "get_balance" }, responses: [{ body: { token: USER_JWT, note: `Bearer ${USER_JWT}`, key: PUBLISHABLE_KEY } }] },
  { name: "expired JWT error, JWT redacted", args: { function_name: "get_balance" }, responses: [{ status: 401, body: { code: "PGRST301", message: `JWT ${USER_JWT} expired` } }], kind: "auth_error" },
  { name: "unknown function (PGRST202)", args: { function_name: "get_balance" }, responses: [{ status: 404, body: { code: "PGRST202", message: "Could not find the function", details: null, hint: null } }], kind: "not_found" },
  { name: "row level security (42501)", args: { function_name: "get_balance" }, responses: [{ status: 403, body: { code: "42501", message: "permission denied for table orders" } }], kind: "permission_denied" },
  { name: "server error keeps the unknown-outcome note", args: { function_name: "get_balance" }, responses: [{ status: 500, body: { message: "boom" } }], kind: "api_error", message: /outcome unknown/ },
  // The test fetch's Response has no statusText; real servers send "Too Many Requests", which the WASM build names.
  { name: "rate limited without a message", args: { function_name: "get_balance" }, responses: [{ status: 429, body: {} }], kind: "rate_limited", message: /API error 429: Too Many Requests/, sameMessage: false },
  { name: "bad SUPABASE_TOOL_TIMEOUT_MS", args: { function_name: "get_balance" }, environment: { SUPABASE_TOOL_TIMEOUT_MS: "fast" }, kind: "invalid_input", message: /SUPABASE_TOOL_TIMEOUT_MS/ },
  { name: "bad SUPABASE_TOOL_MAX_ROWS", args: { function_name: "get_balance" }, environment: { SUPABASE_TOOL_MAX_ROWS: "0" }, kind: "invalid_input", message: /SUPABASE_TOOL_MAX_ROWS/ },
  { name: "bad SUPABASE_TOOL_RPC_ALLOWLIST", args: { function_name: "get_balance" }, environment: { SUPABASE_TOOL_RPC_ALLOWLIST: "ok,bad name" }, kind: "invalid_input", message: /SUPABASE_TOOL_RPC_ALLOWLIST/ },
  { name: "SUPABASE_URL with a path", args: { function_name: "get_balance" }, environment: { SUPABASE_URL: `${PROJECT}/rest/v1` }, kind: "invalid_input", message: /project origin only/ },
  { name: "SUPABASE_URL over http", args: { function_name: "get_balance" }, environment: { SUPABASE_URL: "http://db.example.com" }, kind: "invalid_input", message: /https/ },
  { name: "local http SUPABASE_URL", args: { function_name: "get_balance" }, environment: { SUPABASE_URL: "http://localhost:54321/" }, responses: [{ body: [] }] },
  { name: "slow function", args: { function_name: "get_balance" }, environment: { SUPABASE_TOOL_TIMEOUT_MS: "1000" }, transport: "timeout", kind: "timeout", message: /1000 ms \(SUPABASE_TOOL_TIMEOUT_MS\)/ },
  { name: "connection refused", args: { function_name: "get_balance" }, transport: "refused", kind: "network_error", message: /outcome unknown/, sameMessage: false },
];

const DEFAULT_SECRETS = { user_jwt: USER_JWT };

async function runNode(testCase) {
  const environment = { ...USER_RPC_ENV, ...testCase.environment };
  const recordingFetch = testCase.transport ? failingFetch(testCase.transport) : createRecordingFetch(testCase.responses ?? [{ body: [] }]);
  const toolOperations = pluginDefinition.resolveToolOperations(environment);
  const runner = createOperationRunner({ ...pluginDefinition, operations: toolOperations }, environment, { fetchImpl: recordingFetch });
  const handler = createToolHandler(runner, "call_function", 60000);
  const secrets = "secrets" in testCase ? testCase.secrets : DEFAULT_SECRETS;
  const outcome = await handler(testCase.args, secrets === undefined ? null : toolContext({ secrets })).then(
    (output) => ({ output }),
    (error) => ({ error: { kind: error.kind, message: error.message } }),
  );
  return { ...outcome, calls: (recordingFetch.calls ?? []).map(describeCall) };
}

function runWasm(testCase) {
  const environment = { ...USER_RPC_ENV, ...testCase.environment };
  const responses = [...(testCase.responses ?? [{ body: [] }])];
  const calls = [];
  const respond = (request) => {
    calls.push({ ...request, json: request.body === undefined ? undefined : JSON.parse(request.body) });
    if (testCase.transport === "timeout") return { error: { kind: "timeout", message: `no complete response within ${request.timeout_ms} ms` } };
    if (testCase.transport === "refused") return { error: { kind: "http_error", message: "error sending request: tcp connect error: Connection refused (os error 61)" } };
    const { status = 200, body = {} } = responses.shift() ?? {};
    return { status, headers: { "content-type": "application/json" }, body: status === 204 ? "" : typeof body === "string" ? body : JSON.stringify(body) };
  };
  const secrets = "secrets" in testCase ? testCase.secrets : DEFAULT_SECRETS;
  const request = { name: "call_function", arguments: testCase.args, env: environment, ...(secrets === undefined ? {} : { context: { secrets } }) };
  const response = wasmPlugin.callTool(request, respond);
  const outcome = response.error ? { error: { kind: response.error.kind, message: response.error.message } } : { output: { text: response.text, data: response.data } };
  return { ...outcome, calls: calls.map(describeCall), timeouts: calls.map((call) => call.timeout_ms) };
}

function failingFetch(transport) {
  const calls = [];
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      calls.push({ method: init.method, url: String(url), headers: init.headers, json: JSON.parse(init.body) });
      if (transport === "refused") return reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }));
      const keepAlive = setTimeout(() => reject(new Error("the timeout never fired")), 10000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(init.signal.reason);
      }, { once: true });
    });
  fetchImpl.calls = calls;
  return fetchImpl;
}

function describeCall(call) {
  return { method: call.method, url: call.url, apikey: call.headers?.apikey, authorization: call.headers?.authorization, json: call.json };
}

const assertNoJwt = (value) => assert.ok(!JSON.stringify(value).includes(USER_JWT), "the user JWT leaked");

for (const testCase of CASES) {
  test(`node and wasm agree: ${testCase.name}`, async () => {
    const [nodeRun, wasmRun] = [await runNode(testCase), runWasm(testCase)];
    assert.deepEqual(wasmRun.calls, nodeRun.calls, "HTTP requests");
    if (testCase.kind) {
      assert.equal(nodeRun.error?.kind, testCase.kind, `node: ${JSON.stringify(nodeRun)}`);
      assert.equal(wasmRun.error?.kind, testCase.kind, `wasm: ${JSON.stringify(wasmRun)}`);
      if (testCase.message) assert.match(wasmRun.error.message, testCase.message);
      if (testCase.sameMessage !== false) assert.equal(wasmRun.error.message, nodeRun.error.message);
    } else {
      assert.equal(wasmRun.error, undefined, JSON.stringify(wasmRun.error));
      assert.deepEqual(wasmRun.output.data, nodeRun.output.data);
      assert.equal(wasmRun.output.text, nodeRun.output.text);
    }
    assertNoJwt({ ...wasmRun, calls: [] });
    assertNoJwt({ ...nodeRun, calls: [] });
  });
}

test("wasm passes SUPABASE_TOOL_TIMEOUT_MS to the host as the request deadline", () => {
  assert.deepEqual(runWasm({ args: { function_name: "get_balance" } }).timeouts, [30000]);
  assert.deepEqual(runWasm({ args: { function_name: "get_balance" }, environment: { SUPABASE_TOOL_TIMEOUT_MS: "1000" } }).timeouts, [1000]);
});

test("wasm describes one tool with the Node.js plugin's parameters", () => {
  const manifest = wasmPlugin.describe();
  assert.equal(manifest.name, "supabase");
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["call_function"]);
  const nodeTool = pluginDefinition.resolveToolOperations({ ...USER_RPC_ENV, SUPABASE_TOOL_RPC_ALLOWLIST: "" })[0];
  assert.deepEqual(manifest.tools[0].parameters, nodeTool.parameters);
});

test("wasm serves user_rpc mode only", () => {
  const response = wasmPlugin.callTool({ name: "call_function", arguments: { function_name: "get_balance" }, env: { ...USER_RPC_ENV, SUPABASE_TOOL_MODE: "" } }, () => assert.fail("no request"));
  assert.equal(response.error.kind, "invalid_input");
  assert.match(response.error.message, /user_rpc only/);
});
