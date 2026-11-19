# coingecko

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [CoinGecko API v3](https://docs.coingecko.com):
crypto prices, ranked market data, coin details, historical charts and OHLC candles, search, trending coins,
categories and global market stats. It works without a key (the public API), with a free Demo key or with a paid
Pro key. Every operation is a read, a workflow node and an agent tool.

## Features
- **Prices:** `get_simple_price` (by ids, names or symbols, with market cap, volume and 24h change),
  `get_token_price` (by contract address on a platform), `list_supported_vs_currencies`
- **Markets:** `get_coins_markets` (ranked, filter by ids or category, paginated with `limit`/`cursor`),
  `list_categories`, `get_global`, `get_exchange_rates` (1 BTC in fiat and crypto)
- **Coins:** `list_coins`, `get_coin` (localization, tickers, community and developer data off by default to keep
  the response small), `search`, `get_trending`
- **History:** `get_market_chart` (last N days), `get_market_chart_range` (between dates), `get_ohlc`
- **`api_request`:** any other endpoint, e.g. `/coins/bitcoin/tickers` or Pro-only `/coins/top_gainers_losers`
  (GET only for agents)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- Optional: a CoinGecko API key from the [developer dashboard](https://www.coingecko.com/en/developers/dashboard)

## Installation
```bash
graphrt plugin install ./coingecko
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `COINGECKO_API_KEY` | no | Demo or Pro key (`CG-...`). Without it the keyless public API is used |
| `COINGECKO_API_PLAN` | no | `demo` (default): `api.coingecko.com` with `x-cg-demo-api-key`. `pro`: `pro-api.coingecko.com` with `x-cg-pro-api-key` (a key is then required) |

A node can override the key with `access_token` (from a secret; needs `--trust-plugin coingecko`). Agent tools never
can. The key is redacted from every result and error.

## Pricing and limits
- **Public (no key):** free, shared and strict rate limit (roughly 5 to 15 calls a minute), no SLA.
- **Demo:** free; about 30 calls a minute and a monthly credit cap (10,000 at the time of writing). Attribution to
  CoinGecko is required.
- **Pro (Analyst, Lite, Pro, Enterprise):** paid monthly plans with higher limits and Pro-only endpoints.
  See [coingecko.com/en/api/pricing](https://www.coingecko.com/en/api/pricing).

Every call (also a failed one) counts toward the rate limit; successful calls use credits. Calls are reads, so they
are retried after 5xx and network errors; an agent looping over `get_coin` can use up a Demo month's credits.

## Quick Start
```bash
graphrt run coingecko/example.yaml --plugins .
```
The example prints Bitcoin and Ethereum prices in USD and IDR.

## Usage
```yaml
- id: chart
  type: coingecko.get_market_chart
  coin_id: bitcoin
  vs_currency: idr
  days: "30"
  interval: daily
```
- Coin ids are CoinGecko's own (`bitcoin`, `ethereum`, `solana`), not tickers; use `search` to find them.
- Chart arrays are `[UNIX milliseconds, value]`; OHLC rows `[UNIX ms, open, high, low, close]`.
- Prices are cached by CoinGecko (about 20 to 60 seconds depending on plan).

## Agent policy
All operations are reads and available to agents as tools. `api_request` is GET-only for agents; CoinGecko has no
write or account endpoints.

## Errors
| Kind | When |
|------|------|
| `auth_error` | 401 with `error_code` 10002/10010/10011: missing or invalid key, or a Demo key on the Pro host (set `COINGECKO_API_PLAN`); `COINGECKO_API_PLAN=pro` without a key |
| `permission_denied` | `error_code` 10005/10006: endpoint or data not in your plan |
| `rate_limited` | 429 (retried) |
| `not_found` | unknown coin id or platform |
| `invalid_input` | bad `COINGECKO_API_PLAN`, or a parameter CoinGecko rejects |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus plan, header, redaction and error-code cases.
Verified live: the example with no key (real read) and `/ping` with an invalid key (clean `auth_error`, code 10002).
Price endpoints answer from CoinGecko's cache even with an invalid key.

## License
Apache-2.0
