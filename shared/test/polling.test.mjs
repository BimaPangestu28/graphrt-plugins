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

test("pollUntilDone times out with a NON-retryable error, because the job may still complete", async () => {
  await assert.rejects(
    pollUntilDone({ readStatus: async () => ({}), isDone: () => false, isFailed: () => false, intervalMs: 5, timeoutMs: 20 }),
    (error) => error.kind === "timeout" && error.retryable === false && /check/i.test(error.message),
  );
});

test("pollUntilDone keeps polling through transient status-read errors", async () => {
  const { PluginError } = await import("../lib/graphrt-plugin.mjs");
  const readResults = [
    new PluginError("502", { kind: "api_error" }),
    new PluginError("net", { kind: "network_error" }),
    new PluginError("slow down", { kind: "rate_limited" }),
    { status: "FINISHED" },
  ];
  const result = await pollUntilDone({
    readStatus: async () => {
      const next = readResults.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    isDone: (statusResult) => statusResult.status === "FINISHED",
    isFailed: () => false,
    intervalMs: 1,
    timeoutMs: 1000,
  });
  assert.deepEqual(result, { status: "FINISHED" });
});

test("pollUntilDone stops on non-transient status-read errors", async () => {
  const { PluginError } = await import("../lib/graphrt-plugin.mjs");
  await assert.rejects(
    pollUntilDone({
      readStatus: async () => {
        throw new PluginError("bad token", { kind: "auth_error" });
      },
      isDone: () => false,
      isFailed: () => false,
      intervalMs: 1,
      timeoutMs: 1000,
    }),
    (error) => error.kind === "auth_error",
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
