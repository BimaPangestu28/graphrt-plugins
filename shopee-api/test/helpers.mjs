import { createHmac } from "node:crypto";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

export const TEST_ENVIRONMENT = {
  SHOPEE_PARTNER_ID: "2001887",
  SHOPEE_PARTNER_KEY: "partner-key-for-tests",
  SHOPEE_SHOP_ID: "14701711",
  SHOPEE_ACCESS_TOKEN: "shop-access-token",
  SHOPEE_REFRESH_TOKEN: "shop-refresh-token",
};

export const LIVE_ORIGIN = "https://partner.shopeemobile.com";
export const TEST_ORIGIN = "https://openplatform.sandbox.test-stable.shopee.sg";

/** Canned Shopee success body with a `response` payload. */
export const shopeeOk = (response = {}) => ({ body: { request_id: "R1", error: "", message: "", response } });

/** Canned Shopee error body (Shopee sends these with HTTP 200 as well as 4xx). */
export const shopeeError = (error, message = `msg for ${error}`, status = 200) => ({ status, body: { request_id: "RERR", error, message } });

/**
 * Independent reference signature: HMAC-SHA256(partner key, partner_id + path + timestamp [+ token + shop_id]).
 *
 * @returns Lowercase hex (string)
 */
export function expectedSignature({ path, timestamp, accessToken = "", shopId = "", environment = TEST_ENVIRONMENT }) {
  const baseString = `${environment.SHOPEE_PARTNER_ID}${path}${timestamp}${accessToken}${shopId}`;
  return createHmac("sha256", environment.SHOPEE_PARTNER_KEY).update(baseString).digest("hex");
}

/**
 * Runs one shopee-api operation against canned responses.
 *
 * @returns `{output, calls}` where calls are the recorded requests
 */
export async function runWithResponses(operationName, args, responses = [shopeeOk()], environment = TEST_ENVIRONMENT, source = undefined) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const isNodeOnly = pluginDefinition.operations.find((operation) => operation.name === operationName)?.nodeOnly;
  const output = await runOperation(operationName, args, { source: source ?? (isNodeOnly ? "node" : "tool") });
  return { output, calls: recordingFetch.calls };
}

/**
 * Runs an operation that must fail and returns the PluginError.
 *
 * @returns `{error, calls}`
 */
export async function runExpectingError(operationName, args, responses = [], environment = TEST_ENVIRONMENT, source = undefined) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const isNodeOnly = pluginDefinition.operations.find((operation) => operation.name === operationName)?.nodeOnly;
  try {
    await runOperation(operationName, args, { source: source ?? (isNodeOnly ? "node" : "tool") });
  } catch (error) {
    return { error, calls: recordingFetch.calls };
  }
  throw new Error(`${operationName} was expected to fail`);
}
