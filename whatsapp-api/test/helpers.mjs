import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

export const TEST_ENVIRONMENT = {
  WHATSAPP_ACCESS_TOKEN: "wa-token",
  WHATSAPP_PHONE_NUMBER_ID: "111",
  WHATSAPP_BUSINESS_ACCOUNT_ID: "222",
  GRAPHRT_POLL_INTERVAL_MS: "0",
};

/**
 * Runs one whatsapp-api operation against canned responses.
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
 * Runs one operation that is expected to fail and returns the error together
 * with the recorded requests, so tests can count attempts.
 *
 * @returns `{error, calls}`
 */
export async function runExpectingFailure(operationName, args, responses, environment = TEST_ENVIRONMENT) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  try {
    await runOperation(operationName, args, { source: "tool" });
  } catch (error) {
    return { error, calls: recordingFetch.calls };
  }
  throw new Error(`${operationName} was expected to fail`);
}

/**
 * Asserts that the promise rejects with the given error kind (and message pattern).
 *
 * @returns Promise that resolves when the rejection matched
 */
export function rejectsWithKind(assert, promise, expectedKind, messagePattern) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.kind, expectedKind, error.message);
    if (messagePattern) assert.match(error.message, messagePattern);
    return true;
  });
}
