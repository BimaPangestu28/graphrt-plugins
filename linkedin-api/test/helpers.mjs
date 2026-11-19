import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createPluginDefinition } from "../definition.mjs";

export const TEST_ENVIRONMENT = {
  LINKEDIN_ACCESS_TOKEN: "li-token",
  LINKEDIN_AUTHOR_URN: "urn:li:organization:42",
  GRAPHRT_POLL_INTERVAL_MS: "0",
};

// Most tests run operations as agent tools, so runWithResponses adds the agent opt-ins to every environment and
// runs node-only operations (deletes) as nodes. agent-policy.test.mjs covers the refusals.
const TOOL_OPT_INS = { LINKEDIN_TOOL_ALLOW_POST: "1", LINKEDIN_TOOL_ALLOW_ENGAGE: "1" };

/**
 * Fake DNS: names listed in `addressesByHost` resolve to those addresses, every other name to a public address.
 *
 * @param addressesByHost - `{hostname: string[]}` (object)
 * @returns `async (hostname) => string[]` (function)
 */
export function createFakeResolver(addressesByHost = {}) {
  return async (hostname) => addressesByHost[hostname] ?? ["93.184.216.34"];
}

/**
 * Builds the plugin definition with fake DNS, so tests never resolve names.
 *
 * @param resolveHostAddresses - Fake resolver (function, optional)
 * @returns Plugin definition (object)
 */
export function createTestDefinition(resolveHostAddresses = createFakeResolver()) {
  return createPluginDefinition({ resolveHostAddresses });
}

/**
 * Runs one linkedin-api operation against canned responses.
 *
 * @returns `{output, calls}` where calls are the recorded requests
 */
export async function runWithResponses(operationName, args, responses = [{ body: {} }], environment = TEST_ENVIRONMENT, resolveHostAddresses) {
  const recordingFetch = createRecordingFetch(responses);
  const testDefinition = createTestDefinition(resolveHostAddresses);
  const runOperation = createOperationRunner(testDefinition, { ...TOOL_OPT_INS, ...environment }, { fetchImpl: recordingFetch });
  const isNodeOnly = testDefinition.operations.find((operation) => operation.name === operationName)?.nodeOnly === true;
  const output = await runOperation(operationName, args, { source: isNodeOnly ? "node" : "tool" });
  return { output, calls: recordingFetch.calls };
}
