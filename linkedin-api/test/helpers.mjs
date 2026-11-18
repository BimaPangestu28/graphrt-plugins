import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

export const TEST_ENVIRONMENT = {
  LINKEDIN_ACCESS_TOKEN: "li-token",
  LINKEDIN_AUTHOR_URN: "urn:li:organization:42",
  GRAPHRT_POLL_INTERVAL_MS: "0",
};

/**
 * Runs one linkedin-api operation against canned responses.
 *
 * @returns `{output, calls}` where calls are the recorded requests
 */
export async function runWithResponses(operationName, args, responses = [{ body: {} }], environment = TEST_ENVIRONMENT) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const output = await runOperation(operationName, args, { source: "tool" });
  return { output, calls: recordingFetch.calls };
}
