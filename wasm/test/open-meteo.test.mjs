/**
 * open-meteo: the Node.js plugin and its WebAssembly build (wasm/open-meteo) agree on every case.
 */
import { fileURLToPath } from "node:url";
import * as operationsModule from "../../open-meteo/lib/shared/operations.mjs";
import { pluginDefinition } from "../../open-meteo/definition.mjs";
import { defineParitySuite } from "./rest-parity.mjs";

const FORECAST_TEXT = '{"latitude":-6.9,"longitude":107.6,"elevation":768.0,"utc_offset_seconds":25200,"current":{"time":"2026-11-24T10:00","temperature_2m":24.0,"weather_code":3,"precipitation":0.0},"daily":{"temperature_2m_max":[28.5,1e-7,1.5e300]}}';
const PLACES = { results: [{ id: 1650357, name: "Bandung", latitude: -6.90389, longitude: 107.61861, country_code: "ID", population: 1699719 }], generationtime_ms: 0.5 };

const CASES = [
  { name: "forecast with defaults", operation: "get_forecast", args: { latitude: -6.9, longitude: 107.6 }, responses: [{ body: FORECAST_TEXT }] },
  {
    name: "forecast with every option, values from templates",
    operation: "get_forecast",
    args: { latitude: "-6.9", longitude: " 107.6 ", hourly: '["temperature_2m", "cloud_cover"]', current: [], forecast_days: "3", past_days: 0, temperature_unit: "FAHRENHEIT", timezone: "Asia/Jakarta" },
    responses: [{ body: { hourly: { time: ["a"] } } }],
  },
  { name: "latitude out of range", operation: "get_forecast", args: { latitude: 91, longitude: 0 }, kind: "invalid_input", message: /latitude/ },
  { name: "missing longitude", operation: "get_forecast", args: { latitude: 1 }, kind: "invalid_input" },
  { name: "bad enum", operation: "get_forecast", args: { latitude: 1, longitude: 1, wind_speed_unit: "knots" }, kind: "invalid_input", message: /kmh, ms, mph, kn/ },
  { name: "integer that is not", operation: "get_forecast", args: { latitude: 1, longitude: 1, forecast_days: 2.5 }, kind: "invalid_input" },
  { name: "too many variables", operation: "get_forecast", args: { latitude: 1, longitude: 1, daily: Array.from({ length: 51 }, () => "x") }, kind: "invalid_input" },
  { name: "API error with reason", operation: "get_forecast", args: { latitude: 1, longitude: 1 }, responses: [{ status: 400, body: { error: true, reason: "Cannot initialize WeatherVariable from invalid String value tempeh" } }], kind: "invalid_input" },
  { name: "error in a 200 body", operation: "get_forecast", args: { latitude: 1, longitude: 1 }, responses: [{ body: { error: true, reason: "Latitude must be in range of -90 to 90°." } }], kind: "api_error" },
  { name: "server errors are retried, then reported", operation: "get_forecast", args: { latitude: 1, longitude: 1 }, responses: [{ status: 502, body: "<html>bad gateway</html>" }, { status: 503, body: {} }, { status: 500, body: { reason: "down" } }], kind: "api_error" },
  { name: "a retried server error that recovers", operation: "get_forecast", args: { latitude: 1, longitude: 1 }, responses: [{ status: 503, body: {} }, { body: { ok: 1 } }] },
  { name: "rate limited", operation: "get_forecast", args: { latitude: 1, longitude: 1 }, responses: Array.from({ length: 3 }, () => ({ status: 429, body: { reason: "Too many requests" }, headers: { "retry-after": "1" } })), kind: "rate_limited", rateLimited: true },
  { name: "request timeout", operation: "get_forecast", args: { latitude: 1, longitude: 1 }, transport: "timeout", kind: "network_error" },
  { name: "connection refused", operation: "get_forecast", args: { latitude: 1, longitude: 1 }, transport: "refused", kind: "network_error", sameMessage: false },
  { name: "place search on the geocoding host", operation: "search_locations", args: { name: "Bandung", country_code: "ID", count: 3 }, responses: [{ body: PLACES }] },
  { name: "place search with no results gives null", operation: "search_locations", args: { name: "Zzyzx" }, responses: [{ body: { generationtime_ms: 0.2 } }] },
  { name: "place name too short", operation: "search_locations", args: { name: "B" }, kind: "invalid_input", message: /at least 2/ },
  { name: "unicode place name", operation: "search_locations", args: { name: "München straße & co/+?" }, responses: [{ body: { results: [{ name: "München" }] } }] },
  { name: "api_request GET with query", operation: "api_request", args: { path: "/v1/forecast?latitude=1&x=a b", query: { longitude: 2, hourly: ["a", "b"], obj: { k: 1 } } }, responses: [{ body: { ok: true } }] },
  { name: "api_request plain path", operation: "api_request", args: { path: "/v1/forecast?latitude=1&longitude=2&tag='q'#frag" }, responses: [{ body: [1, 2] }] },
  { name: "api_request POST", operation: "api_request", args: { method: "post", path: "/v1/forecast", body: { a: 1 } }, sources: ["node"], responses: [{ body: {} }] },
  { name: "api_request POST as a tool is refused", operation: "api_request", args: { method: "POST", path: "/v1/forecast" }, sources: ["tool"], kind: "permission_denied" },
  { name: "api_request body with GET", operation: "api_request", args: { path: "/v1/forecast", body: { a: 1 } }, kind: "invalid_input" },
  { name: "api_request relative path", operation: "api_request", args: { path: "v1/forecast" }, kind: "invalid_input" },
  { name: "api_request dot segments", operation: "api_request", args: { path: "/v1/%2e%2e/admin" }, kind: "invalid_input", message: /Unsafe API path/ },
  { name: "api_request double slash", operation: "api_request", args: { path: "//evil.example/x" }, kind: "invalid_input" },
  { name: "huge result becomes a preview for tools", operation: "get_forecast", args: { latitude: 1, longitude: 1 }, responses: [{ body: { blob: "é".repeat(60000) + "x".repeat(50000) } }] },
  { name: "empty body", operation: "get_forecast", args: { latitude: 1, longitude: 1 }, responses: [{ status: 204 }] },
  { name: "text that is not JSON", operation: "get_forecast", args: { latitude: 1, longitude: 1 }, responses: [{ body: "plain text" }] },
  { name: "404 without a message", operation: "api_request", args: { path: "/v2/none" }, responses: [{ status: 404, body: "" }], kind: "not_found" },
];

defineParitySuite({
  pluginName: "open-meteo",
  pluginDefinition,
  operationsModule,
  wasmPath: fileURLToPath(new URL("../open-meteo/open_meteo.wasm", import.meta.url)),
  cases: CASES,
});
