/**
 * currency-rates: the Node.js plugin and its WebAssembly build (wasm/currency-rates) agree on every case.
 */
import { fileURLToPath } from "node:url";
import * as operationsModule from "../../currency-rates/lib/shared/operations.mjs";
import { pluginDefinition } from "../../currency-rates/definition.mjs";
import { defineParitySuite } from "./rest-parity.mjs";

const RATE_ROWS = [{ date: "2026-11-23", base: "USD", quote: "IDR", rate: 16250.5 }, { date: "2026-11-23", base: "USD", quote: "EUR", rate: 0.9123 }];
const PAIR = { date: "2026-11-23", base: "USD", quote: "IDR", rate: 16250.123457 };

const CASES = [
  { name: "latest rates", operation: "get_latest_rates", args: { base: "USD", quotes: ["IDR", "EUR"], providers: ["ECB"] }, responses: [{ body: RATE_ROWS }] },
  { name: "latest rates without options", operation: "get_latest_rates", args: {}, responses: [{ body: RATE_ROWS }] },
  { name: "quotes as a comma template string is not an array", operation: "get_latest_rates", args: { quotes: "IDR,EUR" }, kind: "invalid_input" },
  { name: "quotes as JSON text", operation: "get_latest_rates", args: { quotes: '["IDR"]' }, responses: [{ body: RATE_ROWS }] },
  { name: "base too short", operation: "get_latest_rates", args: { base: "US" }, kind: "invalid_input", message: /at least 3 characters/ },
  { name: "historical rates", operation: "get_historical_rates", args: { date: "2020-01-02", base: "EUR" }, responses: [{ body: RATE_ROWS }] },
  { name: "historical rates need a date", operation: "get_historical_rates", args: { base: "EUR" }, kind: "invalid_input", message: /`date` is required/ },
  { name: "time series by month", operation: "get_rate_time_series", args: { from: "2026-01-01", to: "2026-06-30", group: "Month", quotes: ["IDR"] }, responses: [{ body: RATE_ROWS }] },
  { name: "pair rate", operation: "get_pair_rate", args: { base: "usd", quote: "idr" }, responses: [{ body: PAIR }] },
  { name: "pair rate with odd characters in the path", operation: "get_pair_rate", args: { base: "U S/D", quote: "I?R" }, responses: [{ body: PAIR }] },
  { name: "unknown currency (422)", operation: "get_pair_rate", args: { base: "ABC", quote: "IDR" }, responses: [{ status: 422, body: { status: 422, message: "invalid currency: ABC" } }], kind: "invalid_input", message: /invalid currency/ },
  { name: "not found (404)", operation: "get_currency", args: { code: "XYZ" }, responses: [{ status: 404, body: { message: "not found" } }], kind: "not_found" },
  { name: "currencies, all scopes", operation: "list_currencies", args: { scope: "ALL" }, responses: [{ body: [{ iso_code: "IDR", name: "Indonesian Rupiah" }] }] },
  { name: "providers", operation: "list_providers", args: {}, responses: [{ body: [{ key: "ECB" }] }] },
  { name: "convert", operation: "convert", args: { amount: 100, from: "usd", to: "idr" }, responses: [{ body: PAIR }] },
  { name: "convert on a date, amount from a template", operation: "convert", args: { amount: "12.5", from: "EUR", to: "USD", date: "2024-02-29" }, responses: [{ body: { date: "2024-02-29", base: "EUR", quote: "USD", rate: 1.0812 } }] },
  { name: "convert rounds half away from zero like toFixed", operation: "convert", args: { amount: 0.0078125, from: "EUR", to: "USD" }, responses: [{ body: { date: "2024-02-29", base: "EUR", quote: "USD", rate: 1 } }] },
  { name: "convert with a response without date", operation: "convert", args: { amount: 3, from: "EUR", to: "USD" }, responses: [{ body: { base: "eur", quote: "usd", rate: 0.1 } }] },
  { name: "convert without a rate", operation: "convert", args: { amount: 1, from: "EUR", to: "XXX" }, responses: [{ body: { base: "EUR", quote: "XXX" } }], kind: "api_error", message: /no rate/ },
  { name: "convert negative amount", operation: "convert", args: { amount: -1, from: "EUR", to: "USD" }, kind: "invalid_input" },
  { name: "convert API error", operation: "convert", args: { amount: 1, from: "EUR", to: "ABC" }, responses: [{ status: 422, body: { message: "invalid currency: ABC" } }], kind: "invalid_input" },
  { name: "api_request", operation: "api_request", args: { path: "/v2/rates", query: { base: "USD", quotes: ["IDR", "EUR"] } }, responses: [{ body: RATE_ROWS }] },
];

defineParitySuite({
  pluginName: "currency-rates",
  pluginDefinition,
  operationsModule,
  wasmPath: fileURLToPath(new URL("../currency-rates/currency_rates.wasm", import.meta.url)),
  cases: CASES,
});
