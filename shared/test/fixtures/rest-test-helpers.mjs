/**
 * Helpers for the rest-plugin tests: a minimal valid spec builder and a runner over canned or scripted responses.
 */
import { defineRestPlugin } from "../../lib/rest-plugin.mjs";
import { createOperationRunner } from "../../lib/operations.mjs";
import { createRecordingFetch } from "../../lib/testing.mjs";

export const TEST_KEY = "secret-key-123456";
export const publicResolver = async () => ["93.184.216.34"];

/**
 * Builds a spec with one or more operations and sensible defaults.
 *
 * @param operations - Operation specs (object[])
 * @param overrides - Plugin-level overrides (object)
 * @returns Spec (object)
 */
export function buildSpec(operations, overrides = {}) {
  return {
    name: "probe-api",
    version: "0.0.1",
    description: "Probe API",
    baseUrl: "https://api.example.com/v1",
    auth: { type: "query", param: "api_key", env: "PROBE_KEY" },
    operations,
    ...overrides,
  };
}

/**
 * Runs one operation of a spec (or definition) against responses.
 *
 * @param specOrDefinition - Spec or definition (object)
 * @param operationName - Operation (string)
 * @param args - Arguments (object)
 * @param options - `{responses | fetchImpl, environment, source, signal}` (object)
 * @returns `{output, error, calls}` (Promise<object>)
 */
export async function runOperation(specOrDefinition, operationName, args = {}, options = {}) {
  const definition = specOrDefinition.restSpec ? specOrDefinition : defineRestPlugin(specOrDefinition);
  const fetchImpl = options.fetchImpl ?? createRecordingFetch(options.responses ?? [{ body: {} }]);
  const environment = { PROBE_KEY: TEST_KEY, GRAPHRT_POLL_INTERVAL_MS: "0", ...options.environment };
  const run = createOperationRunner(definition, environment, { fetchImpl, resolveHostAddresses: publicResolver });
  const outcome = await run(operationName, args, { source: options.source ?? "node", signal: options.signal }).then(
    (output) => ({ output }),
    (error) => ({ error }),
  );
  return { ...outcome, calls: fetchImpl.calls ?? [] };
}

/**
 * A recording fetch whose responses come from `respond(url, init, callIndex)`; may wait or throw.
 *
 * @param respond - `async (url, init, callIndex) => {status?, body?, headers?} | Response` (function)
 * @returns fetch with `calls: [{url, init}]` (function)
 */
export function createScriptedFetch(respond) {
  const calls = [];
  const scriptedFetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, headers: init.headers ?? {} });
    const scripted = await respond(String(url), init, calls.length - 1);
    if (scripted instanceof Response) return scripted;
    const { status = 200, body = {}, headers = {} } = scripted ?? {};
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };
  scriptedFetch.calls = calls;
  return scriptedFetch;
}

/**
 * Resolves after `delayMs`, or rejects with the signal's reason when it aborts first.
 *
 * @param delayMs - Delay (number)
 * @param signal - Abort signal (AbortSignal, optional)
 * @returns Promise
 */
export function waitOrAbort(delayMs, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });
}
