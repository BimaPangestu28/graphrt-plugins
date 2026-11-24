/**
 * Parity harness for rest-kit ports: every case runs against the Node.js plugin (its definition, with a recording
 * fetch) and the WebAssembly build (wasm-host.mjs, answering `graphrt::http` from the same canned responses), as an
 * agent tool and as a workflow node, and both must send the same HTTP requests (method, URL, headers, body) and
 * give the same result (tool `text` and `data`, node `outputs`) or the same error kind, message and retryable flag.
 *
 * Case fields:
 *   name, operation, args, env (merged over the suite's), secrets (tool_context secrets), sources (default both),
 *   responses: [{status?, body?, headers?}] in order (a string body is sent as is),
 *   transport: "timeout" | "refused" (every request fails that way),
 *   kind / message: expected error kind and message pattern,
 *   sameMessage: false for transport failures (the text comes from undici vs graphrt-http),
 *   rateLimited: true when Node.js retries after waiting and the WebAssembly build returns at once (no clock):
 *     only the first request is compared.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { STATUS_CODES } from "node:http";
import { loadWasmPlugin } from "./wasm-host.mjs";

// Node.js retries after 1 s and 2 s; the WebAssembly build retries at once. Skip the waits so both send the same
// requests quickly (AbortSignal.timeout does not use setTimeout).
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delayMs, ...callbackArguments) => realSetTimeout(callback, delayMs >= 1000 ? 0 : delayMs, ...callbackArguments);

/**
 * Registers one node:test test per case and source.
 *
 * @param suite - Suite settings (object)
 * @param suite.pluginName - Plugin name (string)
 * @param suite.pluginDefinition - The Node.js plugin's definition (object)
 * @param suite.operationsModule - The plugin's lib/shared/operations.mjs module (object)
 * @param suite.wasmPath - Path of the WebAssembly build (string)
 * @param suite.env - Environment of every case (object)
 * @param suite.cases - Cases (object[])
 * @returns The loaded WebAssembly plugin, for extra tests (object)
 */
export function defineParitySuite({ pluginName, pluginDefinition, operationsModule, wasmPath, env = {}, cases }) {
  const wasmPlugin = loadWasmPlugin(wasmPath);
  for (const testCase of cases) {
    for (const source of testCase.sources ?? ["tool", "node"]) {
      test(`${pluginName} ${source}: ${testCase.name}`, async () => {
        const environment = { ...env, ...testCase.env };
        const nodeRun = await runNode({ pluginDefinition, operationsModule, testCase, source, environment });
        const wasmRun = runWasm({ wasmPlugin, pluginName, testCase, source, environment });
        compareRuns(testCase, nodeRun, wasmRun);
      });
    }
  }
  test(`${pluginName}: the WebAssembly manifest is the Node.js plugin's nodes and tools`, () => {
    const manifest = wasmPlugin.describe();
    const descriptors = operationsModule.buildDescriptors(pluginDefinition);
    assert.equal(manifest.name, pluginDefinition.name);
    assert.equal(manifest.version, pluginDefinition.version);
    assert.deepEqual(manifest.nodes, descriptors.nodes);
    assert.deepEqual(manifest.tools, descriptors.tools);
  });
  return wasmPlugin;
}

function compareRuns(testCase, nodeRun, wasmRun) {
  if (testCase.rateLimited) {
    assert.deepEqual(wasmRun.calls[0], nodeRun.calls[0], "first HTTP request");
    assert.equal(wasmRun.calls.length, 1, "the WebAssembly build does not wait and retry a rate limit");
  } else {
    assert.deepEqual(wasmRun.calls, nodeRun.calls, "HTTP requests");
  }
  if (testCase.kind) {
    assert.equal(nodeRun.error?.kind, testCase.kind, `node: ${JSON.stringify(nodeRun)}`);
    assert.equal(wasmRun.error?.kind, testCase.kind, `wasm: ${JSON.stringify(wasmRun)}`);
    if (testCase.message) assert.match(wasmRun.error.message, testCase.message);
    if (testCase.sameMessage !== false) assert.equal(wasmRun.error.message, nodeRun.error.message);
    assert.equal(wasmRun.error.retryable, nodeRun.error.retryable, "retryable");
    return;
  }
  assert.equal(nodeRun.error, undefined, `node: ${JSON.stringify(nodeRun.error)}`);
  assert.equal(wasmRun.error, undefined, `wasm: ${JSON.stringify(wasmRun.error)}`);
  // As the host receives it: JSON (undefined members dropped).
  assert.deepEqual(wasmRun.output, JSON.parse(JSON.stringify(nodeRun.output)));
}

async function runNode({ pluginDefinition, operationsModule, testCase, source, environment }) {
  const recordingFetch = createParityFetch(testCase);
  const runner = operationsModule.createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const run = source === "tool"
    ? operationsModule.createToolHandler(runner, testCase.operation, 60000)(testCase.args, { secrets: testCase.secrets ?? {} })
    : runner(testCase.operation, testCase.args, { source: "node" }).then((outputs) => ({ outputs }));
  const outcome = await run.then(
    (output) => ({ output }),
    (error) => ({ error: { kind: error.kind, message: error.message, retryable: error.retryable } }),
  );
  return { ...outcome, calls: recordingFetch.calls };
}

function runWasm({ wasmPlugin, pluginName, testCase, source, environment }) {
  const responses = [...(testCase.responses ?? [{ body: {} }])];
  const calls = [];
  const respond = (request) => {
    calls.push({ method: request.method, url: request.url, headers: sortHeaders(request.headers ?? {}), body: request.body });
    if (testCase.transport === "timeout") return { error: { kind: "timeout", message: `no complete response within ${request.timeout_ms} ms` } };
    if (testCase.transport === "refused") return { error: { kind: "http_error", message: "error sending request: tcp connect error: Connection refused (os error 61)" } };
    const { status = 200, body = {}, headers = {} } = responses.shift() ?? {};
    const lowerHeaders = Object.fromEntries(Object.entries({ "content-type": "application/json", ...headers }).map(([name, value]) => [name.toLowerCase(), value]));
    return { status, headers: lowerHeaders, body: status === 204 ? "" : typeof body === "string" ? body : JSON.stringify(body) };
  };
  const response = source === "tool"
    ? wasmPlugin.callTool({ name: testCase.operation, arguments: testCase.args, env: environment, context: { secrets: testCase.secrets ?? {} } }, respond)
    : wasmPlugin.run({ kind: `${pluginName}.${testCase.operation}`, node_id: "n", config: testCase.args, attempt: 1, env: environment }, respond);
  if (response.error) return { error: { kind: response.error.kind, message: response.error.message, retryable: response.error.retryable }, calls };
  return { output: source === "tool" ? { text: response.text, data: response.data } : { outputs: response.outputs }, calls };
}

// A fetch double like shared/lib/testing.mjs's, but with the status text a real server sends.
function createParityFetch(testCase) {
  const responses = [...(testCase.responses ?? [{ body: {} }])];
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ method: init.method ?? "GET", url: String(url), headers: sortHeaders(init.headers ?? {}), body: typeof init.body === "string" ? init.body : undefined });
    if (testCase.transport === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (testCase.transport === "refused") throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    const { status = 200, body = {}, headers = {} } = responses.shift() ?? {};
    const responseText = status === 204 ? null : typeof body === "string" ? body : JSON.stringify(body);
    return new Response(responseText, { status, statusText: STATUS_CODES[status] ?? "", headers: { "content-type": "application/json", ...headers } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function sortHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]).sort(([left], [right]) => left.localeCompare(right)));
}
