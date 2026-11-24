# web-search

**Status:** beta · **ToS risk:** low. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for provider-agnostic web and news search. One
environment variable picks the provider ([Tavily](https://docs.tavily.com),
[Brave Search API](https://api-dashboard.search.brave.com/app/documentation) or [SerpAPI](https://serpapi.com/search-api)
for Google results) and another holds its key. Workflows and agents call the same two operations and get the same
result shape whichever provider is configured.

## Features
- **`search`:** web results
- **`search_news`:** news results (Tavily `topic: news`, Brave `/news/search`, SerpAPI Google News tab `tbm=nws`)

Both take `query`, `max_results` (1 to 20, default 10; SerpAPI at most 10), `country` and `language` (Brave and
SerpAPI), `freshness` (`day`, `week`, `month`, `year`) and `include_answer` (Tavily only, default true). Both return:
```json
{ "provider": "brave", "query": "...", "answer": null,
  "results": [{ "title": "...", "url": "https://...", "snippet": "...", "published_at": "2 hours ago", "source": "example.com" }] }
```
`published_at` is what the provider gives (an ISO date, or text such as "2 hours ago"), or null. `answer` is
Tavily's generated answer, null for the other providers. Full operation reference: [OPERATIONS.md](OPERATIONS.md).

There is no `api_request`: the providers live on different hosts with different auth.

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- An API key for one provider:
  - Tavily: [app.tavily.com](https://app.tavily.com) (keys start with `tvly-`)
  - Brave: [api-dashboard.search.brave.com](https://api-dashboard.search.brave.com) (a "Search" plan subscription token)
  - SerpAPI: [serpapi.com/manage-api-key](https://serpapi.com/manage-api-key)

## Installation
```bash
graphrt plugin install ./web-search
```
No `npm install` needed: the plugin has no dependencies.

## Runtime: Node.js or WebAssembly
This plugin runs on Node.js (the release tarball, above). A sandboxed WebAssembly build with the same nodes, tools,
env variables, results and errors is in [`wasm/web-search`](../wasm/web-search/): no Node.js process, cold runs ~6× faster
(≈18–24 ms instead of ≈110 ms) and ~12× less memory on a warm server, but 1–3 ms slower per warm call. Install one
of the two (same plugin name):

```bash
graphrt plugin install https://github.com/BimaPangestu28/graphrt-plugins --rev main --subdir wasm/web-search
```
The release catalog lists the build in the plugin's `runtimes`. Differences and measurements:
[wasm/README.md](../wasm/README.md#picking-a-runtime).

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `WEB_SEARCH_PROVIDER` | yes | `tavily`, `brave` or `serpapi` |
| `WEB_SEARCH_API_KEY` | yes | The provider's key. Sent as `Authorization: Bearer` (Tavily), `X-Subscription-Token` (Brave) or the `api_key` query parameter (SerpAPI, which has no header auth); redacted from every result and error |

The provider comes only from the environment, never from a node or tool argument. A node can override the key with
`access_token` (from a secret; needs `--trust-plugin web-search`); agent tools never can.

## Pricing
**Every search is billed by the provider** (at the time of writing):
- **Tavily:** 1 credit per basic search; 1,000 free credits a month, then plans from $30/month or $0.008 per credit
  pay-as-you-go ([pricing](https://docs.tavily.com/documentation/api-credits)).
- **Brave:** $5 per 1,000 requests, with $5 of free credit a month ([pricing](https://brave.com/search/api/)).
- **SerpAPI:** 250 free searches a month, then plans from $25/month for 1,000; only successful, uncached searches
  count ([pricing](https://serpapi.com/pricing)).

## Quick Start
```bash
WEB_SEARCH_PROVIDER=tavily WEB_SEARCH_API_KEY=tvly-... graphrt run web-search/example.yaml --plugins .
```
The example searches for Borobudur's opening hours and prints the top result.

## Usage
```yaml
- id: news
  type: web-search.search_news
  query: Bank Indonesia interest rate decision
  freshness: week
  country: ID
  language: en
  max_results: 5
```

## Agent policy
Both operations are agent tools: they only read public search results. Because each call costs money, they are
**never retried after a 5xx, timeout or network error** (the provider may already have billed the query); the error
is `retryable: false`, says the outcome is unknown and where to check usage. 429s are retried (nothing ran). An agent
in a loop can still spend the monthly allowance: use a provider plan with a hard cap.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | `WEB_SEARCH_PROVIDER` missing or unknown (no request is sent); bad arguments |
| `auth_error` | no key; invalid key (Tavily 401, Brave 422 `SUBSCRIPTION_TOKEN_INVALID`, SerpAPI 401) |
| `permission_denied` | Tavily 432/433 (plan or pay-as-you-go limit reached), Brave `OPTION_NOT_IN_PLAN` |
| `rate_limited` | 429 (retried); SerpAPI quota errors sent with HTTP 200 ("run out of searches", "searches for the month are exhausted", hourly throughput limit; not retried) |
| `api_error` | 5xx (not retried, see Agent policy); SerpAPI errors in a 200 body (a "no results" answer is an empty list) |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite for each provider's request plus the neutral mapping,
normalization, provider selection, no-retry and redaction cases. Verified live with an invalid key for each provider:
Tavily `auth_error` 401, Brave `auth_error` 422 `SUBSCRIPTION_TOKEN_INVALID`, SerpAPI `auth_error` 401.

## License
Apache-2.0
