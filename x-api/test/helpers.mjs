import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

export const TEST_ENVIRONMENT = {
  X_ACCESS_TOKEN: "user-token",
  X_USER_ID: "42",
};

/**
 * Runs one x-api operation against canned responses.
 *
 * Besides the recorded calls, it keeps each request's raw `init.body` so tests
 * can inspect multipart FormData bodies (the shared recorder only keeps strings).
 *
 * @returns `{output, calls, rawBodies}`
 */
export async function runWithResponses(operationName, args, responses = [{ body: {} }], environment = TEST_ENVIRONMENT) {
  const recordingFetch = createRecordingFetch(responses);
  const rawBodies = [];
  const capturingFetch = async (url, init = {}) => {
    rawBodies.push(init.body);
    return recordingFetch(url, init);
  };
  const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl: capturingFetch });
  const output = await runOperation(operationName, args, { source: "tool" });
  return { output, calls: recordingFetch.calls, rawBodies };
}

/**
 * Asserts that running the operation fails with the given error kind.
 *
 * @returns Promise that resolves when the rejection matched
 */
export function rejectsWithKind(assert, promise, expectedKind, messagePattern) {
  return assert.rejects(promise, (error) => error.kind === expectedKind && (!messagePattern || messagePattern.test(error.message)));
}
