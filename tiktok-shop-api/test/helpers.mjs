import { createHmac } from "node:crypto";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

export const TEST_ENVIRONMENT = {
  TIKTOK_SHOP_APP_KEY: "app-key-test",
  TIKTOK_SHOP_APP_SECRET: "app-secret-for-tests",
  TIKTOK_SHOP_ACCESS_TOKEN: "TTP_access_token_test",
  TIKTOK_SHOP_REFRESH_TOKEN: "TTP_refresh_token_test",
  TIKTOK_SHOP_CIPHER: "ROW_cipher_test",
};

export const OPEN_API_ORIGIN = "https://open-api.tiktokglobalshop.com";

/** Canned TikTok Shop success body. */
export const tiktokShopOk = (data = {}) => ({ body: { code: 0, message: "Success", request_id: "R1", data } });

/** Canned TikTok Shop error body (sent with HTTP 200 as well as 4xx/5xx). */
export const tiktokShopError = (code, message = `msg for ${code}`, status = 200) => ({ status, body: { code, message, request_id: "RERR", data: null } });

/**
 * Independent reference signature computed straight from the documented algorithm:
 * HMAC-SHA256(secret, secret + path + sorted {key}{value} without sign/access_token + body + secret).
 *
 * @returns Lowercase hex (string)
 */
export function expectedSignature(call, appSecret = TEST_ENVIRONMENT.TIKTOK_SHOP_APP_SECRET) {
  const signedPairs = Object.entries(call.query)
    .filter(([key]) => key !== "sign" && key !== "access_token")
    .sort(([leftKey], [rightKey]) => (leftKey < rightKey ? -1 : 1))
    .map(([key, value]) => `${key}${value}`)
    .join("");
  const stringToSign = `${call.path}${signedPairs}${call.body ?? ""}`;
  return createHmac("sha256", appSecret).update(`${appSecret}${stringToSign}${appSecret}`).digest("hex");
}

/**
 * Runs one tiktok-shop-api operation against canned responses.
 *
 * @returns `{output, calls}` where calls are the recorded requests
 */
export async function runWithResponses(operationName, args, responses = [tiktokShopOk()], environment = TEST_ENVIRONMENT, source = undefined) {
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
