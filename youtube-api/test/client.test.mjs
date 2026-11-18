import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYouTubeError } from "../lib/client.mjs";
import { runWithResponses } from "./helpers.mjs";

const noHeaders = new Headers();

function googleError(code, reason, message = "m") {
  return { error: { code, message, errors: [{ domain: "youtube", reason, message }] } };
}

for (const [status, reason, expectedKind] of [
  [403, "quotaExceeded", "rate_limited"],
  [403, "dailyLimitExceeded", "rate_limited"],
  [403, "rateLimitExceeded", "rate_limited"],
  [429, "userRateLimitExceeded", "rate_limited"],
  [403, "commentsDisabled", "permission_denied"],
  [403, "forbidden", "permission_denied"],
  [403, "insufficientPermissions", "permission_denied"],
  [401, "authorizationRequired", "auth_error"],
  [404, "videoNotFound", "not_found"],
  [404, "commentNotFound", "not_found"],
  [404, "liveChatNotFound", "not_found"],
]) {
  test(`parseYouTubeError maps reason ${reason} to ${expectedKind}`, () => {
    assert.equal(parseYouTubeError(status, googleError(status, reason)).kind, expectedKind);
  });
}

test("parseYouTubeError includes the reason in the message", () => {
  const parsed = parseYouTubeError(403, googleError(403, "commentsDisabled", "Comments are disabled"));
  assert.match(parsed.message, /Comments are disabled/);
  assert.match(parsed.message, /commentsDisabled/);
});

test("parseYouTubeError leaves unknown reasons and non-Google bodies to the status mapping", () => {
  assert.equal(parseYouTubeError(400, googleError(400, "invalidValue")).kind, undefined);
  assert.deepEqual(parseYouTubeError(502, { text: "Bad gateway" }, noHeaders), {});
});

test("quotaExceeded is rate_limited, not retried and has no retryAfterMs", async () => {
  const quotaResponse = { status: 403, body: googleError(403, "quotaExceeded", "The request cannot be completed because you have exceeded your quota.") };
  await assert.rejects(runWithResponses("get_videos", { video_ids: ["v1"] }, [quotaResponse, { body: {} }]), (error) => {
    assert.equal(error.kind, "rate_limited");
    assert.equal(error.retryable, false);
    assert.equal(error.retryAfterMs, undefined);
    assert.match(error.message, /quota/);
    return true;
  });
});

test("quotaExceeded is attempted exactly once", async () => {
  const { createRecordingFetch } = await import("../lib/shared/testing.mjs");
  const { createOperationRunner } = await import("../lib/shared/operations.mjs");
  const { pluginDefinition } = await import("../definition.mjs");
  const recordingFetch = createRecordingFetch([{ status: 403, body: googleError(403, "quotaExceeded") }, { body: {} }]);
  const runOperation = createOperationRunner(pluginDefinition, { YOUTUBE_ACCESS_TOKEN: "yt-token" }, { fetchImpl: recordingFetch });
  await assert.rejects(runOperation("delete_comment", { comment_id: "c1" }, { source: "tool" }), (error) => error.kind === "rate_limited");
  assert.equal(recordingFetch.calls.length, 1);
});

test("rateLimitExceeded errors are marked retryable", async () => {
  const { createApiClient } = await import("../lib/shared/api-client.mjs");
  const { createRecordingFetch } = await import("../lib/shared/testing.mjs");
  const recordingFetch = createRecordingFetch([{ status: 403, body: googleError(403, "rateLimitExceeded") }]);
  const client = createApiClient({ baseUrl: "https://www.googleapis.com/youtube/v3", parseError: parseYouTubeError, fetchImpl: recordingFetch, maxRetries: 0 });
  await assert.rejects(client.request({ path: "/videos" }), (error) => error.kind === "rate_limited" && error.retryable === true);
});

test("api errors never contain the access token", async () => {
  const tokenEchoResponse = { status: 401, body: googleError(401, "authorizationRequired", "bad token yt-token") };
  await assert.rejects(runWithResponses("get_videos", { video_ids: ["v1"] }, [tokenEchoResponse]), (error) => error.kind === "auth_error" && !error.message.includes("yt-token"));
});
