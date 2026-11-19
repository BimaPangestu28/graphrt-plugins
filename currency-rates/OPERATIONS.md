# currency-rates operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `currency-rates.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_latest_rates` | Latest reference rates for a base currency: rows of {date, base, quote, rate} | base, quotes, providers |
| `get_historical_rates` | Reference rates on a past date (the last published day on or before it): rows of {date, base, quote, rate} | **date**, base, quotes, providers |
| `get_rate_time_series` | Rates for every published day in a date range, optionally one row per week or month: rows of {date, base, quote, rate} | **from**, to, base, quotes, group, providers |
| `get_pair_rate` | One rate {date, base, quote, rate}: 1 base = rate quote, latest or on a date | **base**, **quote**, date |
| `list_currencies` | Currencies with rates: iso_code, name, symbol, type (currency or crypto), start_date and end_date | scope |
| `get_currency` | One currency: name, symbol, ISO numeric code, date range and the providers that publish it | **code** |
| `list_providers` | Central banks and other sources Frankfurter publishes: key, name, country, rate type, pivot currency, date range |  |
| `api_request` | Call any Frankfurter API endpoint that has no dedicated operation, e.g. path "/v2/rates". Only the API's own host is allowed. | method, **path**, query, body |
| `convert` | Convert an amount between currencies with the latest (or a dated) reference rate: {amount, from, to, date, rate, result} | **amount**, **from**, **to**, date |
