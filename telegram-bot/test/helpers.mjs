import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

export const TEST_TOKEN = "123456:TEST-secret_token-value";
export const TEST_ENVIRONMENT = { TELEGRAM_BOT_TOKEN: TEST_TOKEN };
export const BOT_PATH = `/bot${TEST_TOKEN}`;

/**
 * Wraps a Telegram result in the Bot API success envelope.
 *
 * @param result - Value of `result` (any)
 * @returns Canned response `{body}` (object)
 */
export const okResponse = (result = true) => ({ body: { ok: true, result } });

/**
 * Runs one telegram-bot operation against canned responses.
 *
 * @returns `{output, calls}`
 */
export async function runWithResponses(operationName, args, responses = [okResponse()], { environment = TEST_ENVIRONMENT, source = "tool" } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const output = await runOperation(operationName, args, { source });
  return { output, calls: recordingFetch.calls };
}

/**
 * Runs one operation that is expected to fail and returns the error with the recorded requests.
 *
 * @returns `{error, calls}`
 */
export async function runExpectingFailure(operationName, args, responsesOrFetch, { environment = TEST_ENVIRONMENT, source = "tool" } = {}) {
  const fetchImpl = typeof responsesOrFetch === "function" ? responsesOrFetch : createRecordingFetch(responsesOrFetch);
  const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl });
  try {
    await runOperation(operationName, args, { source });
  } catch (error) {
    return { error, calls: fetchImpl.calls ?? [] };
  }
  throw new Error(`${operationName} was expected to fail`);
}
