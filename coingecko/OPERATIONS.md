# coingecko operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `coingecko.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_simple_price` | Current prices of coins in one or more currencies: {coin_id: {usd: 62673, usd_24h_change: ...}} | ids, names, symbols, **vs_currencies**, include_market_cap, include_24hr_vol, include_24hr_change, include_last_updated_at, precision |
| `get_token_price` | Current prices of tokens by contract address on a platform: {contract_address: {usd: ...}} | **platform_id**, **contract_addresses**, **vs_currencies**, include_market_cap, include_24hr_vol, include_24hr_change, include_last_updated_at, precision |
| `list_supported_vs_currencies` | Currency codes usable as vs_currency (usd, idr, eur, btc, ...) |  |
| `list_coins` | Every coin's id, symbol and name (large: about 17,000 entries), optionally with contract addresses per platform | include_platform |
| `get_coins_markets` | Coins ranked with price, market cap, volume, 24h high/low, price change and supply; paginated | **vs_currency**, ids, names, symbols, category, order, sparkline, price_change_percentage, precision, cursor, limit |
| `get_coin` | One coin: description, links, categories, genesis date, market_data (price, ATH, supply) and more | **coin_id**, localization, tickers, market_data, community_data, developer_data, sparkline |
| `get_market_chart` | Historical prices, market caps and volumes for the last N days: arrays of [UNIX ms, value] | **coin_id**, **vs_currency**, **days**, interval, precision |
| `get_market_chart_range` | Historical prices, market caps and volumes between two dates: arrays of [UNIX ms, value] | **coin_id**, **vs_currency**, **from**, **to**, precision |
| `get_ohlc` | Open/high/low/close candles: arrays of [UNIX ms, open, high, low, close] | **coin_id**, **vs_currency**, **days**, precision |
| `search` | Find coins, exchanges, categories and NFTs by name or symbol; coins[] has id, name, symbol, market_cap_rank | **query** |
| `get_trending` | Coins, NFTs and categories trending on CoinGecko in the last 24 hours |  |
| `get_global` | Total market cap and volume per currency, market cap percentages (BTC dominance), number of coins and markets |  |
| `list_categories` | Categories with market cap, 24h change, volume and top coins | order |
| `get_exchange_rates` | The value of 1 BTC in fiat currencies, crypto and commodities: {usd: {name, unit, value, type}} |  |
| `api_request` | Call any CoinGecko API endpoint that has no dedicated operation, e.g. path "/coins/bitcoin/tickers". Only the API's own host is allowed. | method, **path**, query, body |
