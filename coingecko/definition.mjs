/**
 * coingecko plugin definition: crypto prices, markets and charts from the CoinGecko API v3
 * (https://docs.coingecko.com). Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Three access modes, chosen by env:
 *   - no COINGECKO_API_KEY: the keyless public API (api.coingecko.com, low shared rate limit);
 *   - a Demo key (COINGECKO_API_PLAN=demo, the default): api.coingecko.com with `x-cg-demo-api-key`;
 *   - a paid key (COINGECKO_API_PLAN=pro): pro-api.coingecko.com with `x-cg-pro-api-key`.
 * Every operation is a read.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { PluginError } from "./lib/shared/graphrt-plugin.mjs";

const KEY_ENV = "COINGECKO_API_KEY";
const PLAN_ENV = "COINGECKO_API_PLAN";
const PLANS = {
  demo: { baseUrl: "https://api.coingecko.com/api/v3", header: "x-cg-demo-api-key" },
  pro: { baseUrl: "https://pro-api.coingecko.com/api/v3", header: "x-cg-pro-api-key" },
};
const PRECISION_VALUES = ["full", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18"];
const stringList = (description, required = false) => ({ in: "query", type: "array", items: { type: "string" }, maxItems: 250, ...(required ? { required: true } : {}), description });
const flag = (description) => ({ in: "query", type: "boolean", description });
const coinIdParam = { in: "path", type: "string", required: true, description: "CoinGecko coin id, e.g. bitcoin (see search or list_coins)" };
const vsCurrencyParam = { in: "query", type: "string", required: true, description: "Quote currency, e.g. usd, idr, eur, btc (see list_supported_vs_currencies)" };
const precisionParam = { in: "query", type: "string", enum: PRECISION_VALUES, description: "Decimal places of prices, or full" };
const priceFlags = {
  include_market_cap: flag("Add market caps"),
  include_24hr_vol: flag("Add 24h volumes"),
  include_24hr_change: flag("Add 24h price change percentages"),
  include_last_updated_at: flag("Add last update times (UNIX seconds)"),
  precision: precisionParam,
};

function readPlan(environment) {
  const planName = environment?.[PLAN_ENV]?.trim().toLowerCase() || "demo";
  if (!PLANS[planName]) throw new Error(`${PLAN_ENV} must be demo or pro`);
  return PLANS[planName];
}

/**
 * Picks the API host from COINGECKO_API_PLAN (demo or no key: api.coingecko.com; pro: pro-api.coingecko.com).
 *
 * @param environment - Environment variables (object)
 * @returns Base URL (string)
 * @throws Error - When COINGECKO_API_PLAN is neither demo nor pro (becomes invalid_input)
 */
export function resolveCoinGeckoUrl(environment) {
  return readPlan(environment).baseUrl;
}

/**
 * Custom auth hook: sends the key (node access_token or COINGECKO_API_KEY) in the plan's header; without a key the
 * public API is used, except on the pro plan, which needs one.
 *
 * @param request - `{headers, credential, environment}` from the declarative layer (object)
 * @returns Secrets to redact (string[])
 * @throws PluginError kind `auth_error` - On the pro plan without a key
 */
export function authorizeCoinGecko({ headers, credential, environment }) {
  const plan = readPlan(environment);
  const apiKey = credential || environment?.[KEY_ENV]?.trim();
  if (!apiKey) {
    if (plan === PLANS.pro) throw new PluginError(`${PLAN_ENV}=pro needs ${KEY_ENV}`, { kind: "auth_error" });
    return [];
  }
  headers[plan.header] = apiKey;
  return [apiKey, encodeURIComponent(apiKey)];
}

const operations = [
  {
    name: "get_simple_price",
    title: "Coin prices",
    description: "Current prices of coins in one or more currencies: {coin_id: {usd: 62673, usd_24h_change: ...}}",
    path: "/simple/price",
    params: {
      ids: stringList("Coin ids, e.g. [bitcoin, ethereum] (or use names/symbols)"),
      names: stringList("Coin names, e.g. [Bitcoin]"),
      symbols: stringList("Coin symbols, e.g. [btc, eth] (top coins by market cap win ties)"),
      vs_currencies: stringList("Quote currencies, e.g. [usd, idr]", true),
      ...priceFlags,
    },
  },
  {
    name: "get_token_price",
    title: "Token prices by contract",
    description: "Current prices of tokens by contract address on a platform: {contract_address: {usd: ...}}",
    path: "/simple/token_price/{platform_id}",
    params: {
      platform_id: { in: "path", type: "string", required: true, description: "Asset platform id, e.g. ethereum, binance-smart-chain, solana" },
      contract_addresses: stringList("Token contract addresses", true),
      vs_currencies: stringList("Quote currencies, e.g. [usd]", true),
      ...priceFlags,
    },
  },
  { name: "list_supported_vs_currencies", title: "Supported quote currencies", description: "Currency codes usable as vs_currency (usd, idr, eur, btc, ...)", path: "/simple/supported_vs_currencies" },
  {
    name: "list_coins",
    title: "List coins",
    description: "Every coin's id, symbol and name (large: about 17,000 entries), optionally with contract addresses per platform",
    path: "/coins/list",
    params: { include_platform: flag("Add contract addresses per platform") },
  },
  {
    name: "get_coins_markets",
    title: "Coin market data",
    description: "Coins ranked with price, market cap, volume, 24h high/low, price change and supply; paginated",
    path: "/coins/markets",
    params: {
      vs_currency: vsCurrencyParam,
      ids: stringList("Only these coin ids"),
      names: stringList("Only these coin names"),
      symbols: stringList("Only these symbols"),
      category: { in: "query", type: "string", description: "Only this category id, e.g. layer-1, meme-token (see list_categories)" },
      order: { in: "query", type: "string", enum: ["market_cap_desc", "market_cap_asc", "volume_desc", "volume_asc", "id_asc", "id_desc"], description: "Sort order (default market_cap_desc)" },
      sparkline: flag("Add 7-day sparkline prices"),
      price_change_percentage: stringList("Extra price change windows: 1h, 24h, 7d, 14d, 30d, 200d, 1y"),
      precision: precisionParam,
    },
    response: { pagePagination: { pageParam: "page", sizeParam: "per_page" }, maxLimit: 250, defaultLimit: 100 },
  },
  {
    name: "get_coin",
    title: "Coin details",
    description: "One coin: description, links, categories, genesis date, market_data (price, ATH, supply) and more",
    path: "/coins/{coin_id}",
    params: {
      coin_id: coinIdParam,
      localization: { in: "query", type: "boolean", default: false, description: "Include names and descriptions in every language (large)" },
      tickers: { in: "query", type: "boolean", default: false, description: "Include exchange tickers (large)" },
      market_data: { in: "query", type: "boolean", default: true, description: "Include market data" },
      community_data: { in: "query", type: "boolean", default: false, description: "Include community data" },
      developer_data: { in: "query", type: "boolean", default: false, description: "Include developer data" },
      sparkline: { in: "query", type: "boolean", default: false, description: "Include the 7-day sparkline" },
    },
  },
  {
    name: "get_market_chart",
    title: "Coin market chart",
    description: "Historical prices, market caps and volumes for the last N days: arrays of [UNIX ms, value]",
    path: "/coins/{coin_id}/market_chart",
    params: {
      coin_id: coinIdParam,
      vs_currency: vsCurrencyParam,
      days: { in: "query", type: "string", required: true, description: 'Days back, e.g. "1", "30", "365" or "max" (1 day: 5-minute data, 2-90: hourly, more: daily)' },
      interval: { in: "query", type: "string", enum: ["daily"], description: "daily: force daily points" },
      precision: precisionParam,
    },
  },
  {
    name: "get_market_chart_range",
    title: "Coin market chart (date range)",
    description: "Historical prices, market caps and volumes between two dates: arrays of [UNIX ms, value]",
    path: "/coins/{coin_id}/market_chart/range",
    params: {
      coin_id: coinIdParam,
      vs_currency: vsCurrencyParam,
      from: { in: "query", type: "string", required: true, description: "Start: YYYY-MM-DD, ISO date-time or UNIX seconds" },
      to: { in: "query", type: "string", required: true, description: "End: YYYY-MM-DD, ISO date-time or UNIX seconds" },
      precision: precisionParam,
    },
  },
  {
    name: "get_ohlc",
    title: "Coin OHLC candles",
    description: "Open/high/low/close candles: arrays of [UNIX ms, open, high, low, close]",
    path: "/coins/{coin_id}/ohlc",
    params: {
      coin_id: coinIdParam,
      vs_currency: vsCurrencyParam,
      days: { in: "query", type: "string", required: true, enum: ["1", "7", "14", "30", "90", "180", "365"], description: "Days back (candle size grows with the range)" },
      precision: precisionParam,
    },
  },
  {
    name: "search",
    title: "Search coins",
    description: "Find coins, exchanges, categories and NFTs by name or symbol; coins[] has id, name, symbol, market_cap_rank",
    path: "/search",
    params: { query: { in: "query", type: "string", required: true, minLength: 1, description: "Name or symbol, e.g. pepe" } },
  },
  { name: "get_trending", title: "Trending coins", description: "Coins, NFTs and categories trending on CoinGecko in the last 24 hours", path: "/search/trending" },
  {
    name: "get_global",
    title: "Global crypto market",
    description: "Total market cap and volume per currency, market cap percentages (BTC dominance), number of coins and markets",
    path: "/global",
    response: { dataPath: "data" },
  },
  {
    name: "list_categories",
    title: "Coin categories",
    description: "Categories with market cap, 24h change, volume and top coins",
    path: "/coins/categories",
    params: {
      order: { in: "query", type: "string", enum: ["market_cap_desc", "market_cap_asc", "name_desc", "name_asc", "market_cap_change_24h_desc", "market_cap_change_24h_asc"], description: "Sort order" },
    },
  },
  {
    name: "get_exchange_rates",
    title: "BTC exchange rates",
    description: "The value of 1 BTC in fiat currencies, crypto and commodities: {usd: {name, unit, value, type}}",
    path: "/exchange_rates",
    response: { dataPath: "rates" },
  },
];

export const pluginDefinition = defineRestPlugin({
  name: "coingecko",
  version: "0.1.0",
  description: "CoinGecko crypto data (public, Demo or Pro key): prices, markets, coin details, charts, OHLC, search, trending and global stats",
  apiName: "CoinGecko API",
  extraEnv: [KEY_ENV, PLAN_ENV],
  baseUrl: resolveCoinGeckoUrl,
  auth: { type: "custom", authorize: authorizeCoinGecko },
  // Errors are {"status": {"error_code": 10002, "error_message": "..."}}; older ones {"error": "..."}.
  errors: {
    messagePath: ["status.error_message", "error", "message"],
    codePath: "status.error_code",
    kindByCode: { 10002: "auth_error", 10010: "auth_error", 10011: "auth_error", 10005: "permission_denied", 10006: "permission_denied" },
  },
  apiRequest: { examplePath: "/coins/bitcoin/tickers" },
  operations,
});
