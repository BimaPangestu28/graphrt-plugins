import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition, resolveCoinGeckoUrl } from "../definition.mjs";

const API = "https://api.coingecko.com/api/v3";
const DEMO_KEY = "CG-contract-demo-key-0001";

describeRestPluginContract(pluginDefinition, {
  environment: { COINGECKO_API_KEY: DEMO_KEY },
  checkAuth: (call) => {
    assert.equal(call.headers["x-cg-demo-api-key"], DEMO_KEY);
    assert.equal(call.headers["x-cg-pro-api-key"], undefined);
  },
  operations: {
    get_simple_price: {
      args: { ids: ["bitcoin", "ethereum"], vs_currencies: ["usd", "idr"], include_24hr_change: true },
      request: { method: "GET", url: `${API}/simple/price`, query: { ids: "bitcoin,ethereum", vs_currencies: "usd,idr", include_24hr_change: "true" } },
      response: { body: { bitcoin: { usd: 62673, idr: 1142000000 } } },
      expect: { data: { bitcoin: { usd: 62673, idr: 1142000000 } } },
    },
    get_token_price: {
      args: { platform_id: "ethereum", contract_addresses: ["0xdac17f958d2ee523a2206206994597c13d831ec7"], vs_currencies: ["usd"] },
      request: { method: "GET", url: `${API}/simple/token_price/ethereum`, query: { contract_addresses: "0xdac17f958d2ee523a2206206994597c13d831ec7", vs_currencies: "usd" } },
    },
    list_supported_vs_currencies: {
      args: {},
      request: { method: "GET", url: `${API}/simple/supported_vs_currencies`, query: "absent" },
    },
    list_coins: {
      args: { include_platform: true },
      request: { method: "GET", url: `${API}/coins/list`, query: { include_platform: "true" } },
    },
    get_coins_markets: {
      args: { vs_currency: "usd", category: "layer-1", order: "volume_desc", price_change_percentage: ["24h", "7d"], limit: 50 },
      request: { method: "GET", url: `${API}/coins/markets`, query: { vs_currency: "usd", category: "layer-1", order: "volume_desc", price_change_percentage: "24h,7d", per_page: "50" } },
      response: { body: [{ id: "bitcoin", current_price: 62673 }] },
      expect: { data: [{ id: "bitcoin", current_price: 62673 }] },
    },
    get_coin: {
      args: { coin_id: "bitcoin" },
      request: {
        method: "GET",
        url: `${API}/coins/bitcoin`,
        query: { localization: "false", tickers: "false", market_data: "true", community_data: "false", developer_data: "false", sparkline: "false" },
      },
    },
    get_market_chart: {
      args: { coin_id: "bitcoin", vs_currency: "usd", days: "30", interval: "daily" },
      request: { method: "GET", url: `${API}/coins/bitcoin/market_chart`, query: { vs_currency: "usd", days: "30", interval: "daily" } },
      response: { body: { prices: [[1731974400000, 62000]], market_caps: [], total_volumes: [] } },
      expect: { data: { prices: [[1731974400000, 62000]], market_caps: [], total_volumes: [] } },
    },
    get_market_chart_range: {
      args: { coin_id: "ethereum", vs_currency: "eur", from: "2026-01-01", to: "2026-02-01" },
      request: { method: "GET", url: `${API}/coins/ethereum/market_chart/range`, query: { vs_currency: "eur", from: "2026-01-01", to: "2026-02-01" } },
    },
    get_ohlc: {
      args: { coin_id: "bitcoin", vs_currency: "usd", days: "7" },
      request: { method: "GET", url: `${API}/coins/bitcoin/ohlc`, query: { vs_currency: "usd", days: "7" } },
    },
    search: {
      args: { query: "pepe" },
      request: { method: "GET", url: `${API}/search`, query: { query: "pepe" } },
    },
    get_trending: {
      args: {},
      request: { method: "GET", url: `${API}/search/trending`, query: "absent" },
    },
    get_global: {
      args: {},
      request: { method: "GET", url: `${API}/global`, query: "absent" },
      response: { body: { data: { active_cryptocurrencies: 17000 } } },
      expect: { data: { active_cryptocurrencies: 17000 } },
    },
    list_categories: {
      args: { order: "market_cap_desc" },
      request: { method: "GET", url: `${API}/coins/categories`, query: { order: "market_cap_desc" } },
    },
    get_exchange_rates: {
      args: {},
      request: { method: "GET", url: `${API}/exchange_rates`, query: "absent" },
      response: { body: { rates: { usd: { name: "US Dollar", value: 62673 } } } },
      expect: { data: { usd: { name: "US Dollar", value: 62673 } } },
    },
  },
});

async function runPing(environment, response = { body: { gecko_says: "(V3) To the Moon!" } }) {
  const recordingFetch = createRecordingFetch([response]);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const result = await run("get_global", {}, { source: "tool" });
  return { result, call: recordingFetch.calls[0] };
}

test("without a key the public API is called with no key header", async () => {
  const { call } = await runPing({});
  assert.equal(new URL(call.url).origin, "https://api.coingecko.com");
  assert.equal(call.headers["x-cg-demo-api-key"], undefined);
  assert.equal(call.headers["x-cg-pro-api-key"], undefined);
});

test("COINGECKO_API_PLAN=pro uses pro-api.coingecko.com and x-cg-pro-api-key", async () => {
  const { call } = await runPing({ COINGECKO_API_KEY: "CG-pro-0001", COINGECKO_API_PLAN: "pro" });
  assert.equal(call.url, "https://pro-api.coingecko.com/api/v3/global");
  assert.equal(call.headers["x-cg-pro-api-key"], "CG-pro-0001");
  assert.equal(call.headers["x-cg-demo-api-key"], undefined);
});

test("an unknown plan is refused, and pro without a key is an auth_error before any request", async () => {
  assert.throws(() => resolveCoinGeckoUrl({ COINGECKO_API_PLAN: "enterprise" }), /demo or pro/);
  const recordingFetch = createRecordingFetch([]);
  const run = createOperationRunner(pluginDefinition, { COINGECKO_API_PLAN: "pro" }, { fetchImpl: recordingFetch });
  await assert.rejects(run("get_global", {}, { source: "tool" }), (error) => error.kind === "auth_error");
  assert.equal(recordingFetch.calls.length, 0);
});

test("the key is redacted when CoinGecko echoes it", async () => {
  const { result } = await runPing({ COINGECKO_API_KEY: DEMO_KEY }, { body: { data: { echoed: `key ${DEMO_KEY}` } } });
  assert.equal(JSON.stringify(result).includes(DEMO_KEY), false);
});

test("CoinGecko's {status: {error_code, error_message}} errors map to kinds", async () => {
  const invalidKey = { status: 401, body: { status: { error_code: 10002, error_message: "API Key Missing." } } };
  await assert.rejects(runPing({ COINGECKO_API_KEY: DEMO_KEY }, invalidKey), (error) => error.kind === "auth_error" && error.message.includes("API Key Missing"));
  const proOnly = { status: 401, body: { status: { error_code: 10005, error_message: "You may not have access to this endpoint" } } };
  await assert.rejects(runPing({ COINGECKO_API_KEY: DEMO_KEY }, proOnly), (error) => error.kind === "permission_denied");
});

test("manifest: the key is optional and agents get every read", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions.env.sort(), ["COINGECKO_API_KEY", "COINGECKO_API_PLAN"]);
  assert.equal(manifest.tools.length, manifest.nodes.length);
});
