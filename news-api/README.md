# news-api

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for [NewsAPI.org](https://newsapi.org/docs) v2. It
searches news articles and blog posts from tens of thousands of sources, reads top headlines by country, category
or source, and lists the sources. Every operation is a read, a workflow node and an agent tool.

**Why NewsAPI:** it is the most widely used general news search API with a stable, documented v2 interface and a
free key for development. Its limits matter (see Pricing): the free plan is for development only and delays
articles by 24 hours. For production news search without a NewsAPI business plan, the `web-search` plugin's
`search_news` (Tavily, Brave or SerpAPI) is the alternative.

## Features
- **`search_articles`:** `/v2/everything` with keywords and operators, fields to match (`search_in`), sources,
  domains to include or exclude, date range, language and sort order; paginated with `limit`/`cursor`
- **`get_top_headlines`:** breaking headlines by `country`, `category`, `sources` or `query`; paginated
- **`list_sources`:** source ids for `sources`, by category, language or country
- **`api_request`:** any other NewsAPI path (GET only for agents)

`data` is the `articles` (or `sources`) array. Article `content` is truncated to 200 characters by NewsAPI; follow
`url` for the full text. Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A NewsAPI key from [newsapi.org/register](https://newsapi.org/register)

## Installation
```bash
graphrt plugin install ./news-api
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `NEWSAPI_API_KEY` | yes | API key, sent as the `X-Api-Key` header (never in the URL) |

A node can override the key with `access_token` (from a secret; needs `--trust-plugin news-api`). Agent tools never
can.

## Pricing
- **Developer (free):** 100 requests a day, articles delayed 24 hours, search up to a month back, development and
  testing only (not staging or production).
- **Business ($449/month):** 250,000 requests a month, then $0.0018 per extra request; real-time articles, 5 years
  of search. **Advanced ($1,749/month)** and Enterprise for more. See [newsapi.org/pricing](https://newsapi.org/pricing).

Calls are treated as reads and retried after 5xx and network errors: they are covered by the plan's included
requests, and only overage on paid plans is billed (a fraction of a cent).

## Quick Start
```bash
NEWSAPI_API_KEY=... graphrt run news-api/example.yaml --plugins .
```
The example prints the top US business headlines.

## Usage
```yaml
- id: news
  type: news-api.search_articles
  query: '"Bank Indonesia" AND (rupiah OR inflation)'
  language: en
  from: "2026-11-01"
  sort_by: publishedAt
  limit: 20
```
- `get_top_headlines` cannot mix `sources` with `country` or `category` (NewsAPI returns `parametersIncompatible`).
- `search_articles` needs at least one of `query`, `sources` or `domains`.

## Agent policy
All operations are reads and available to agents as tools. `api_request` is GET-only for agents. An agent can use up
the free plan's 100 daily requests quickly; NewsAPI then answers `rateLimited`.

## Errors
| Kind | When |
|------|------|
| `auth_error` | `apiKeyInvalid`, `apiKeyMissing`, `apiKeyDisabled` (401) |
| `rate_limited` | `rateLimited` (429, retried) or `apiKeyExhausted` |
| `invalid_input` | `parameterInvalid`, `parametersMissing`, `parametersIncompatible`, `sourcesTooMany`, `maximumResultsReached` (the free plan stops at 100 results) |
| `not_found` | `sourceDoesNotExist` |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus header and error-code cases. Verified live with an
invalid key (clean `auth_error`, `apiKeyInvalid`).

## License
Apache-2.0
