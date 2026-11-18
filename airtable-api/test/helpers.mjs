import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

export const BASE_ID = "appAAAAAAAAAAAAAA";
export const OTHER_BASE_ID = "appBBBBBBBBBBBBBB";
export const RECORD_ID = "recAAAAAAAAAAAAAA";
export const RECORD_ID_2 = "recBBBBBBBBBBBBBB";
export const TEST_ENVIRONMENT = { AIRTABLE_TOKEN: "patTestSecretToken.123", AIRTABLE_BASE_ID: BASE_ID };

/**
 * Runs one operation against canned responses.
 *
 * @returns `{output, calls}` where calls are the recorded requests
 */
export async function runWithResponses(operationName, args, responses = [{ body: {} }], { source = "tool", environment = TEST_ENVIRONMENT } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const output = await runOperation(operationName, args, { source });
  return { output, calls: recordingFetch.calls };
}

export const airtableError = (status, type, message = "m") => ({ status, body: { error: { type, message } } });
export const isInvalidInput = (error) => error.kind === "invalid_input";
