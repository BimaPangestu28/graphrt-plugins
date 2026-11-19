import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition, restDefinition } from "../definition.mjs";

const API = "https://api.frankfurter.dev";

describeRestPluginContract(restDefinition, {
  operations: {
    get_latest_rates: {
      args: { base: "USD", quotes: ["IDR", "EUR"] },
      request: { method: "GET", url: `${API}/v2/rates`, query: { base: "USD", quotes: "IDR,EUR" } },
      response: { body: [{ date: "2026-11-19", base: "USD", quote: "IDR", rate: 18237 }] },
      expect: { data: [{ date: "2026-11-19", base: "USD", quote: "IDR", rate: 18237 }] },
    },
    get_historical_rates: {
      args: { date: "2024-01-05", base: "EUR", quotes: ["USD"], providers: ["ECB"] },
      request: { method: "GET", url: `${API}/v2/rates`, query: { date: "2024-01-05", base: "EUR", quotes: "USD", providers: "ECB" } },
    },
    get_rate_time_series: {
      args: { from: "2026-01-01", to: "2026-03-01", quotes: ["USD"], group: "month" },
      request: { method: "GET", url: `${API}/v2/rates`, query: { from: "2026-01-01", to: "2026-03-01", quotes: "USD", group: "month" } },
    },
    get_pair_rate: {
      args: { base: "usd", quote: "idr", date: "2024-01-05" },
      request: { method: "GET", url: `${API}/v2/rate/usd/idr`, query: { date: "2024-01-05" } },
      response: { body: { date: "2024-01-05", base: "USD", quote: "IDR", rate: 15520 } },
      expect: { data: { date: "2024-01-05", base: "USD", quote: "IDR", rate: 15520 } },
    },
    list_currencies: {
      args: { scope: "all" },
      request: { method: "GET", url: `${API}/v2/currencies`, query: { scope: "all" } },
    },
    get_currency: {
      args: { code: "IDR" },
      request: { method: "GET", url: `${API}/v2/currency/IDR`, query: "absent" },
    },
    list_providers: {
      args: {},
      request: { method: "GET", url: `${API}/v2/providers`, query: "absent" },
    },
  },
});

async function runOperation(operationName, args, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, {}, { fetchImpl: recordingFetch });
  return { result: await run(operationName, args, { source: "tool" }), calls: recordingFetch.calls };
}

test("currency-rates needs no credential: no secrets, no env, no node access_token", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions, { network: true, secrets: false, env: [] });
  assert.ok(manifest.tools.some((tool) => tool.name === "convert"));
});

test("convert multiplies the amount by the pair rate", async () => {
  const { result, calls } = await runOperation("convert", { amount: "250", from: "usd", to: "idr" }, [{ body: { date: "2026-11-19", base: "USD", quote: "IDR", rate: 18237 } }]);
  assert.equal(new URL(calls[0].url).pathname, "/v2/rate/usd/idr");
  assert.deepEqual(result.data, { amount: 250, from: "USD", to: "IDR", date: "2026-11-19", rate: 18237, result: 4559250 });
});

test("convert passes the date and rounds the result to 6 decimals", async () => {
  const { result, calls } = await runOperation("convert", { amount: 1, from: "IDR", to: "USD", date: "2024-01-05" }, [{ body: { date: "2024-01-05", base: "IDR", quote: "USD", rate: 0.0000644329 } }]);
  assert.equal(new URL(calls[0].url).searchParams.get("date"), "2024-01-05");
  assert.equal(result.data.result, 0.000064);
});

test("convert refuses a negative amount before any request", async () => {
  const recordingFetch = createRecordingFetch([]);
  const run = createOperationRunner(pluginDefinition, {}, { fetchImpl: recordingFetch });
  await assert.rejects(run("convert", { amount: -1, from: "USD", to: "IDR" }, { source: "tool" }), (error) => error.kind === "invalid_input");
  assert.equal(recordingFetch.calls.length, 0);
});

test("convert fails clearly when the response has no numeric rate", async () => {
  await assert.rejects(runOperation("convert", { amount: 1, from: "USD", to: "IDR" }, [{ body: { date: "2026-11-19" } }]), (error) => error.kind === "api_error");
});

test("an unknown currency (422 {status, message}) is invalid_input with Frankfurter's message", async () => {
  await assert.rejects(
    runOperation("get_pair_rate", { base: "ABC", quote: "USD" }, [{ status: 422, body: { status: 422, message: "invalid currency: ABC" } }]),
    (error) => error.kind === "invalid_input" && error.message.includes("invalid currency: ABC"),
  );
});
