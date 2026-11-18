import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { clearCachedAccessTokens } from "../lib/oauth.mjs";
import { pluginDefinition } from "../definition.mjs";

export const TEST_ENVIRONMENT = { YOUTUBE_ACCESS_TOKEN: "yt-token", GRAPHRT_POLL_INTERVAL_MS: "0" };

export const REFRESH_ENVIRONMENT = {
  YOUTUBE_REFRESH_TOKEN: "refresh-secret-value",
  YOUTUBE_CLIENT_ID: "client-id.apps.googleusercontent.com",
  YOUTUBE_CLIENT_SECRET: "client-secret-value",
  GRAPHRT_POLL_INTERVAL_MS: "0",
};

/**
 * Runs one youtube-api operation against canned responses, starting from an empty token cache.
 *
 * @returns `{output, calls}` where calls are the recorded requests
 */
export async function runWithResponses(operationName, args, responses = [{ body: {} }], environment = TEST_ENVIRONMENT, source = "tool") {
  clearCachedAccessTokens();
  return runKeepingTokenCache(operationName, args, responses, environment, source);
}

/**
 * Like runWithResponses but keeps the module-level token cache from earlier runs.
 *
 * @returns `{output, calls}`
 */
export async function runKeepingTokenCache(operationName, args, responses = [{ body: {} }], environment = TEST_ENVIRONMENT, source = "tool") {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const output = await runOperation(operationName, args, { source });
  return { output, calls: recordingFetch.calls };
}
