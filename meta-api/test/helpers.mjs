import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

export const TEST_ENVIRONMENT = {
  META_ACCESS_TOKEN: "page-token",
  META_PAGE_ID: "111",
  META_IG_USER_ID: "222",
  GRAPHRT_POLL_INTERVAL_MS: "0",
};

/**
 * Runs one meta-api operation against canned responses.
 *
 * @returns `{output, calls}` where calls are the recorded requests
 */
export async function runWithResponses(operationName, args, responses = [{ body: {} }], environment = TEST_ENVIRONMENT) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const output = await runOperation(operationName, args, { source: "tool" });
  return { output, calls: recordingFetch.calls };
}
