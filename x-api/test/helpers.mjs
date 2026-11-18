import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

export const TEST_ENVIRONMENT = {
  X_ACCESS_TOKEN: "user-token",
  X_USER_ID: "42",
};

/** A public address, so fake image hosts pass the public-host check without DNS. */
export const PUBLIC_TEST_ADDRESS = "93.184.216.34";

/**
 * Builds a fake host resolver for image downloads.
 *
 * @param addressesByHost - `{hostname: string[]}`; unknown hosts resolve to PUBLIC_TEST_ADDRESS (object)
 * @returns `async (hostname) => string[]` (function)
 */
export function createFakeResolver(addressesByHost = {}) {
  return async (hostname) => addressesByHost[hostname] ?? [PUBLIC_TEST_ADDRESS];
}

/**
 * Runs one x-api operation against canned responses.
 *
 * Besides the recorded calls, it keeps each request's raw `init.body` so tests
 * can inspect multipart FormData bodies (the shared recorder only keeps strings).
 *
 * @returns `{output, calls, rawBodies}`
 */
export async function runWithResponses(operationName, args, responses = [{ body: {} }], environment = TEST_ENVIRONMENT, resolveHostAddresses = createFakeResolver()) {
  const testRun = prepareTestRun(responses, environment, resolveHostAddresses);
  const output = await testRun.run(operationName, args);
  return { output, calls: testRun.calls, rawBodies: testRun.rawBodies };
}

/**
 * Runs one operation that is expected to fail and returns the error with the calls made.
 *
 * @returns `{error, calls}` (Promise<object>)
 */
export async function runExpectingFailure(operationName, args, responses = [], environment = TEST_ENVIRONMENT, resolveHostAddresses = createFakeResolver()) {
  const testRun = prepareTestRun(responses, environment, resolveHostAddresses);
  try {
    await testRun.run(operationName, args);
  } catch (error) {
    return { error, calls: testRun.calls };
  }
  throw new Error(`${operationName} was expected to fail`);
}

function prepareTestRun(responses, environment, resolveHostAddresses) {
  const recordingFetch = createRecordingFetch(responses);
  const rawBodies = [];
  const capturingFetch = async (url, init = {}) => {
    rawBodies.push(init.body);
    return recordingFetch(url, init);
  };
  const testDefinition = { ...pluginDefinition, createClient: (clientOptions) => ({ ...pluginDefinition.createClient(clientOptions), resolveHostAddresses }) };
  const runOperation = createOperationRunner(testDefinition, environment, { fetchImpl: capturingFetch });
  const run = (operationName, args) => {
    // Node-only operations (token refresh) are run the way graphrt runs them: as nodes.
    const isNodeOnly = pluginDefinition.operations.find((operation) => operation.name === operationName)?.nodeOnly;
    return runOperation(operationName, args, { source: isNodeOnly ? "node" : "tool" });
  };
  return { run, calls: recordingFetch.calls, rawBodies };
}

/**
 * Asserts that running the operation fails with the given error kind.
 *
 * @returns Promise that resolves when the rejection matched
 */
export function rejectsWithKind(assert, promise, expectedKind, messagePattern) {
  return assert.rejects(promise, (error) => error.kind === expectedKind && (!messagePattern || messagePattern.test(error.message)));
}
