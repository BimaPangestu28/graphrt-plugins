import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

export const TEST_ENVIRONMENT = { NOTION_TOKEN: "ntn_test_secret_token" };
export const PAGE_ID = "0123456789abcdef0123456789abcdef";
export const DATA_SOURCE_ID = "11111111-2222-3333-4444-555555555555";
export const DATABASE_ID = "99999999999999999999999999999999";

/**
 * Runs one operation against canned responses.
 *
 * @returns `{output, calls}` where calls are the recorded requests
 */
export async function runWithResponses(operationName, args, responses = [{ body: {} }], source = "tool", extraEnvironment = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const environment = { ...TEST_ENVIRONMENT, ...extraEnvironment };
  const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const output = await runOperation(operationName, args, { source });
  return { output, calls: recordingFetch.calls };
}

export const notionError = (status, code, message = "m") => ({ status, body: { object: "error", status, code, message } });
export const isInvalidInput = (error) => error.kind === "invalid_input";
