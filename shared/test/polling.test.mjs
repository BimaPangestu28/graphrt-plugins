import { test } from "node:test";
import assert from "node:assert/strict";
import { pollUntilDone } from "../lib/polling.mjs";

test("pollUntilDone returns the first status that is done", async () => {
  const statuses = ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
  const result = await pollUntilDone({
    readStatus: async () => ({ status: statuses.shift() }),
    isDone: (statusResult) => statusResult.status === "FINISHED",
    isFailed: () => false,
    intervalMs: 1,
    timeoutMs: 1000,
  });
  assert.deepEqual(result, { status: "FINISHED" });
});

test("pollUntilDone throws api_error with the failure description", async () => {
  await assert.rejects(
    pollUntilDone({
      readStatus: async () => ({ status: "ERROR", reason: "bad aspect ratio" }),
      isDone: () => false,
      isFailed: (statusResult) => (statusResult.status === "ERROR" ? statusResult.reason : false),
      intervalMs: 1,
      timeoutMs: 1000,
    }),
    (error) => error.kind === "api_error" && /bad aspect ratio/.test(error.message),
  );
});

test("pollUntilDone times out with a retryable timeout error", async () => {
  await assert.rejects(
    pollUntilDone({ readStatus: async () => ({}), isDone: () => false, isFailed: () => false, intervalMs: 5, timeoutMs: 20 }),
    (error) => error.kind === "timeout" && error.retryable === true,
  );
});

test("pollUntilDone stops when cancelled", async () => {
  await assert.rejects(
    pollUntilDone({
      readStatus: async () => ({}),
      isDone: () => false,
      isFailed: () => false,
      intervalMs: 1,
      timeoutMs: 1000,
      signal: AbortSignal.abort(),
    }),
    (error) => error.kind === "cancelled",
  );
});
