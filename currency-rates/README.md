# currency-rates

**Status:** stable · **ToS risk:** none. Public no-auth API (Frankfurter); the example converted with a real rate live (2026-11-19). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for [Frankfurter](https://frankfurter.dev) v2, a free
and open-source API for reference exchange rates published by the European Central Bank and other central banks
(Bank Indonesia, the US Treasury and more than 40 others). No account or API key is needed. Every operation is a
workflow node and an agent tool.

## Features
- **`get_latest_rates`:** latest rates for a base currency (default EUR), optionally only some quote currencies
- **`get_historical_rates`:** rates on a past date (the last published day on or before it)
- **`get_rate_time_series`:** rates for every published day in a range, or one row per week or month (`group`)
- **`get_pair_rate`:** one pair, latest or on a date: `{date, base, quote, rate}`
- **`convert`:** an amount from one currency into another: `{amount, from, to, date, rate, result}` (hand-written:
  Frankfurter has no conversion endpoint, so it reads the pair rate and multiplies; `result` is rounded to 6 decimals)
- **`list_currencies`, `get_currency`, `list_providers`:** what is available and who publishes it
- **`api_request`:** any other Frankfurter endpoint, e.g. `/v2/providers/ECB/rates` (GET only for agents)

Rates are rows of `{date, base, quote, rate}` (1 base = rate quote). `providers` limits a call to one source, e.g.
`[ECB]`; without it Frankfurter blends its providers. Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- Network access to `api.frankfurter.dev`

## Installation
```bash
graphrt plugin install ./currency-rates
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
None. The plugin reads no environment variables and asks for no secrets.

**Terms:** Frankfurter is free with no published quota; rates are reference rates (usually published once per
working day, around 16:00 CET for the ECB), not trading quotes. Do not use them for settlement.

## Quick Start
```bash
graphrt run currency-rates/example.yaml --plugins .
```
The example converts 100 USD to IDR.

## Usage
```yaml
- id: rate
  type: currency-rates.get_rate_time_series
  from: "2026-01-01"
  to: "2026-06-30"
  base: USD
  quotes: [IDR]
  group: month
```
Dates are `YYYY-MM-DD`. Currency codes are case-insensitive (`usd` works).

## Agent policy
All operations are free reads and available to agents as tools. `api_request` is GET-only for agents.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | 400/422: unknown currency or bad date (Frankfurter's message is included), negative `amount` |
| `not_found` | 404: unknown currency, provider or no rate for the pair |
| `api_error` | 5xx (retried), or a pair response without a rate |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus `convert` cases. Verified live with a real read
(`graphrt run currency-rates/example.yaml --plugins .`).

## License
Apache-2.0
