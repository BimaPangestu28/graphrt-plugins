import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { detectRateLimits } from "../lib/rate-limit-fetch.mjs";
import { pluginDefinition } from "../definition.mjs";

const NOW_MS = Date.UTC(2026, 10, 19, 12, 0, 0);

async function rateLimitedResponse(status, headers, body = { message: "API rate limit exceeded for user ID 1." }) {
  const fetchImpl = async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  return detectRateLimits(fetchImpl, () => NOW_MS)("https://api.github.com/user", {});
}

test("403 with x-ratelimit-remaining: 0 becomes 429 with retry-after from x-ratelimit-reset", async () => {
  const resetSeconds = NOW_MS / 1000 + 120;
  const response = await rateLimitedResponse(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetSeconds) });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "120");
  assert.equal((await response.json()).message, "API rate limit exceeded for user ID 1.");
});

test("403 with retry-after (secondary limit) becomes 429 and keeps retry-after", async () => {
  const response = await rateLimitedResponse(403, { "retry-after": "30" }, { message: "You have exceeded a secondary rate limit." });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "30");
});

test("403 whose message mentions a rate limit becomes 429 with a 60 s default wait", async () => {
  const response = await rateLimitedResponse(403, {}, { message: "You have exceeded a secondary rate limit. Please wait a few minutes." });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
});

test("an ordinary 403 and other statuses pass through untouched", async () => {
  const forbidden = await rateLimitedResponse(403, { "x-ratelimit-remaining": "4999" }, { message: "Resource not accessible by personal access token" });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).message, "Resource not accessible by personal access token");
  const notFound = await rateLimitedResponse(404, { "x-ratelimit-remaining": "0" }, { message: "Not Found" });
  assert.equal(notFound.status, 404);
});

test("operations report an exhausted limit as rate_limited with retryAfterMs and do not wait an hour", async () => {
  const resetSeconds = Math.ceil(Date.now() / 1000) + 3600;
  const recordingFetch = createRecordingFetch([{ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetSeconds) }, body: { message: "API rate limit exceeded for user ID 1." } }]);
  const run = createOperationRunner(pluginDefinition, { GITHUB_TOKEN: "ghp_test" }, { fetchImpl: recordingFetch });
  await assert.rejects(run("get_repo", { owner: "o", repo: "r" }, { source: "tool" }), (error) => error.kind === "rate_limited" && error.retryAfterMs > 3_500_000 && error.message.includes("rate limit exceeded"));
  assert.equal(recordingFetch.calls.length, 1);
});
