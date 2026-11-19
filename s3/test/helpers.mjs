import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

export const FIXED_NOW = new Date("2026-11-19T10:00:00Z");
export const SECRET_KEY = "test-secret-key-value/With+Chars";
export const SESSION_TOKEN = "test-session-token-value";
export const TEST_ENVIRONMENT = { AWS_ACCESS_KEY_ID: "AKIATESTKEY", AWS_SECRET_ACCESS_KEY: SECRET_KEY, AWS_REGION: "eu-west-1" };

/**
 * A fetch double: replays `responses` in order and records each request (Buffer bodies kept as Buffers).
 *
 * @param responses - `{status?, headers?, body?}` items; body is a string or Buffer (object[])
 * @returns fetch function with `calls` (function)
 */
export function createS3Fetch(responses = []) {
  const remainingResponses = [...responses];
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: { ...init.headers }, body: init.body, redirect: init.redirect });
    const next = remainingResponses.shift() ?? {};
    if (next.throws) throw next.throws;
    const status = next.status ?? 200;
    const body = status === 204 || init.method === "HEAD" ? null : (next.body ?? "");
    return new Response(body, { status, headers: { "content-type": "application/xml", ...next.headers } });
  };
  fakeFetch.calls = calls;
  return fakeFetch;
}

/**
 * Runs one operation with a fixed clock and no retry delay.
 *
 * @returns `{output, calls}`
 */
export async function runS3(operationName, args, { responses = [{}], environment = TEST_ENVIRONMENT, source = "node" } = {}) {
  const fakeFetch = createS3Fetch(responses);
  const definition = createPluginDefinition({ now: () => FIXED_NOW, retryBaseDelayMs: 1 });
  const runOperation = createOperationRunner(definition, environment, { fetchImpl: fakeFetch });
  const output = await runOperation(operationName, args, { source });
  return { output, calls: fakeFetch.calls };
}

/**
 * Like runS3 but returns the thrown error and the calls.
 *
 * @returns `{error, calls}`
 */
export async function runS3Failing(operationName, args, options = {}) {
  const fakeFetch = createS3Fetch(options.responses ?? [{}]);
  const definition = createPluginDefinition({ now: () => FIXED_NOW, retryBaseDelayMs: 1 });
  const runOperation = createOperationRunner(definition, options.environment ?? TEST_ENVIRONMENT, { fetchImpl: fakeFetch });
  try {
    await runOperation(operationName, args, { source: options.source ?? "node" });
  } catch (error) {
    return { error, calls: fakeFetch.calls };
  }
  throw new Error(`${operationName} did not fail`);
}

/**
 * Creates a fresh temp directory (realpath, so macOS /var -> /private/var does not matter).
 *
 * @param prefix - Directory name prefix (string)
 * @returns Absolute path (string)
 */
export function makeTempDirectory(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export const xmlError = (status, code, message = code) => ({ status, body: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message><RequestId>r1</RequestId></Error>` });

/**
 * Creates a FIFO with the system mkfifo (no shell).
 *
 * @param fifoPath - Path to create (string)
 */
export function mkfifoSync(fifoPath) {
  execFileSync("mkfifo", [fifoPath]);
}
