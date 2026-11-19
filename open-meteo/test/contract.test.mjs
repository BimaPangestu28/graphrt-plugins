import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner, buildManifest } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const DEFAULT_CURRENT = "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m";
const DEFAULT_DAILY = "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max";

describeRestPluginContract(pluginDefinition, {
  operations: {
    get_forecast: {
      args: { latitude: "-6.2", longitude: 106.85, hourly: ["uv_index"], temperature_unit: "Fahrenheit" },
      request: {
        method: "GET",
        path: "/v1/forecast",
        query: {
          latitude: "-6.2",
          longitude: "106.85",
          current: DEFAULT_CURRENT,
          hourly: "uv_index",
          daily: DEFAULT_DAILY,
          timezone: "auto",
          forecast_days: "7",
          temperature_unit: "fahrenheit",
        },
      },
      response: { body: { latitude: -6.2, current: { temperature_2m: 25.1 } } },
    },
    search_locations: {
      args: { name: "Bandung", country_code: "ID", count: 3 },
      request: { method: "GET", path: "/v1/search", query: { name: "Bandung", count: "3", language: "en", countryCode: "ID" } },
      response: { body: { results: [{ name: "Bandung", latitude: -6.92, longitude: 107.6 }] } },
    },
  },
});

async function runOperation(operationName, args, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, {}, { fetchImpl: recordingFetch });
  return { result: await run(operationName, args, { source: "tool" }), calls: recordingFetch.calls };
}

test("open-meteo needs no credential: no secrets, no env, no node access_token", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions, { network: true, secrets: false, env: [] });
  assert.equal("access_token" in manifest.nodes[0].config_schema.properties, false);
});

test("search_locations goes to the geocoding host and returns the results array", async () => {
  const { result, calls } = await runOperation("search_locations", { name: "Bandung" }, [{ body: { results: [{ name: "Bandung" }] } }]);
  assert.equal(new URL(calls[0].url).origin, "https://geocoding-api.open-meteo.com");
  assert.deepEqual(result.data, [{ name: "Bandung" }]);
});

test("search_locations returns null when no place matches", async () => {
  const { result } = await runOperation("search_locations", { name: "zzzzqqq" }, [{ body: { generationtime_ms: 0.05 } }]);
  assert.equal(result.data, null);
});

test("Open-Meteo's {error, reason} body becomes an invalid_input error with the reason", async () => {
  const reason = "Latitude must be in range of -90 to 90°. Given: 200.0.";
  await assert.rejects(
    runOperation("api_request", { path: "/v1/forecast", query: { latitude: 200, longitude: 1 } }, [{ status: 400, body: { error: true, reason } }]),
    (error) => error.kind === "invalid_input" && error.message.includes(reason),
  );
});

test("coordinates out of range are refused before any request", async () => {
  const recordingFetch = createRecordingFetch([]);
  const run = createOperationRunner(pluginDefinition, {}, { fetchImpl: recordingFetch });
  await assert.rejects(run("get_forecast", { latitude: 91, longitude: 0 }, { source: "tool" }), (error) => error.kind === "invalid_input");
  await assert.rejects(run("get_forecast", { latitude: 0, longitude: 0, forecast_days: 17 }, { source: "tool" }), (error) => error.kind === "invalid_input");
  assert.equal(recordingFetch.calls.length, 0);
});
