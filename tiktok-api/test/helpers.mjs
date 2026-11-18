import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

export const TEST_ENVIRONMENT = {
  TIKTOK_ACCESS_TOKEN: "open-token",
  TIKTOK_BUSINESS_ACCESS_TOKEN: "business-token",
  TIKTOK_BUSINESS_ID: "biz-1",
  TIKTOK_CLIENT_KEY: "client-key-env",
  TIKTOK_CLIENT_SECRET: "client-secret-env",
  GRAPHRT_POLL_INTERVAL_MS: "0",
};

export const OPEN_ORIGIN = "https://open.tiktokapis.com";
export const BUSINESS_PATH_PREFIX = "/open_api/v1.3";

/** Canned Open API success body. */
export const openOk = (data = {}) => ({ body: { data, error: { code: "ok", message: "", log_id: "L1" } } });

/** Canned Business API success body. */
export const businessOk = (data = {}) => ({ body: { code: 0, message: "OK", request_id: "R1", data } });

/**
 * Runs one tiktok-api operation against canned responses.
 *
 * @returns `{output, calls}` where calls are the recorded requests
 */
export async function runWithResponses(operationName, args, responses = [openOk()], environment = TEST_ENVIRONMENT, source = undefined) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  // Node-only operations (token refresh) are run the way graphrt runs them: as nodes.
  const isNodeOnly = pluginDefinition.operations.find((operation) => operation.name === operationName)?.nodeOnly;
  const output = await runOperation(operationName, args, { source: source ?? (isNodeOnly ? "node" : "tool") });
  return { output, calls: recordingFetch.calls };
}
