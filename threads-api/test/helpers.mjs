import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

export const TEST_ENVIRONMENT = {
  THREADS_ACCESS_TOKEN: "threads-token",
  GRAPHRT_POLL_INTERVAL_MS: "0",
  // Most tests run operations as agent tools; agent-policy.test.mjs covers the refusals without these.
  THREADS_TOOL_ALLOW_POST: "1",
  THREADS_TOOL_ALLOW_ENGAGE: "1",
};

/**
 * Runs one threads-api operation against canned responses.
 *
 * @param operationName - Operation to run (string)
 * @param args - Tool arguments (object)
 * @param responses - Canned responses for the recording fetch (Array<object>)
 * @param environment - Environment variables (object)
 * @returns `{output, calls}` where calls are the recorded requests
 */
export async function runWithResponses(operationName, args, responses = [{ body: {} }], environment = TEST_ENVIRONMENT) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  // Node-only operations (token refresh) are run the way graphrt runs them: as nodes.
  const isNodeOnly = pluginDefinition.operations.find((operation) => operation.name === operationName)?.nodeOnly;
  const output = await runOperation(operationName, args, { source: isNodeOnly ? "node" : "tool" });
  return { output, calls: recordingFetch.calls };
}
