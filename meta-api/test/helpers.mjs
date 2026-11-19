import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

export const TEST_ENVIRONMENT = {
  META_ACCESS_TOKEN: "page-token",
  META_PAGE_ID: "111",
  META_IG_USER_ID: "222",
  GRAPHRT_POLL_INTERVAL_MS: "0",
};

// Most tests run operations as agent tools, so runWithResponses adds the agent opt-ins to every environment and
// runs node-only operations (deletes) as nodes. agent-policy.test.mjs covers the refusals.
const TOOL_OPT_INS = { META_TOOL_ALLOW_POST: "1", META_TOOL_ALLOW_ENGAGE: "1", META_TOOL_ALLOW_DM: "1", META_TOOL_RECIPIENT_ALLOWLIST: "psid1, p" };

/**
 * Runs one meta-api operation against canned responses.
 *
 * @returns `{output, calls}` where calls are the recorded requests
 */
export async function runWithResponses(operationName, args, responses = [{ body: {} }], environment = TEST_ENVIRONMENT) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, { ...TOOL_OPT_INS, ...environment }, { fetchImpl: recordingFetch });
  const isNodeOnly = pluginDefinition.operations.find((operation) => operation.name === operationName)?.nodeOnly === true;
  const output = await runOperation(operationName, args, { source: isNodeOnly ? "node" : "tool" });
  return { output, calls: recordingFetch.calls };
}
