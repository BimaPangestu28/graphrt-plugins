# google-search-console

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the
[Google Search Console API v1](https://developers.google.com/webmaster-tools/v1/api_reference_index): Search
Analytics (clicks, impressions, CTR and position from Google Search), URL Inspection, sites and sitemaps. Every
method is called on `https://searchconsole.googleapis.com` (sites, sitemaps and Search Analytics on the
`/webmasters/v3/...` paths that host still serves, URL Inspection on `/v1/...`).

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs). Google
credentials use the shared Google auth files (`google-auth`, `google-rest-auth`, `google-token-endpoint`,
`service-account`), copied unchanged from `google-analytics` into [`lib/`](lib/).

## Features
- **`query_search_analytics`:** rows grouped by `dimensions` (`date`, `hour`, `query`, `page`, `country`, `device`,
  `searchAppearance`) for a date range, with `dimension_filter_groups`, `search_type` (web, image, video, news,
  discover, googleNews), `aggregation_type` and `data_state` (`final`, `all` for fresh data, `hourly_all` with the
  `hour` dimension). `limit` is `rowLimit` (1–25,000, default 1,000) and `cursor` is `startRow`: `next_cursor` is
  set while a page comes back full.
- **`inspect_url`:** index status of one URL (verdict, coverage, last crawl, canonicals, mobile usability, rich
  results)
- **Sites:** `list_sites`, `get_site`, `add_site` (opt-in), `delete_site` (node only)
- **Sitemaps:** `list_sitemaps` (optionally inside a sitemap index), `get_sitemap`, `submit_sitemap` (opt-in),
  `delete_sitemap` (node only)
- **`api_request`:** any other endpoint, e.g. `/webmasters/v3/sites` (GET only for agents)

`site_url` is the property exactly as Search Console names it: `https://www.example.com/` (URL-prefix property,
trailing slash included) or `sc-domain:example.com` (Domain property). It and `sitemap_url` are sent as one
encoded path segment. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Google Cloud project with the **Google Search Console API** enabled

## Installation
```bash
graphrt plugin install ./google-search-console
```

## Configuration
| Env var | Purpose |
|---|---|
| `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth refresh trio (scope `webmasters.readonly`; `webmasters` if you use the writes) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Path to a service account key file; add the service account's email as a user of each property |
| `GOOGLE_ACCESS_TOKEN` | A ready access token (used only when neither of the above is set) |
| `GOOGLE_SEARCH_CONSOLE_TOOL_ALLOW_WRITES` | `1` lets agent tools use `submit_sitemap` and `add_site` |

Credential order: a node's `access_token` (needs `--trust-plugin google-search-console`), then the refresh trio,
then the service account, then `GOOGLE_ACCESS_TOKEN`.

**Scopes:** reads request `https://www.googleapis.com/auth/webmasters.readonly`; only write requests (PUT, DELETE)
request `https://www.googleapis.com/auth/webmasters`. For a service account that is per request; a refresh token
carries the scopes it was granted with, so grant `webmasters.readonly` unless you need the writes.

### Getting the credentials
1. Google Cloud console: enable the Google Search Console API.
2. Either create an OAuth client and get a refresh token for `webmasters.readonly` (or `webmasters`), or create a
   service account, download a JSON key, and in Search Console → Settings → Users and permissions add its
   `client_email` as a user (Restricted for reads, Full or Owner for sitemap submission).

**Pricing / limits:** the API is free. Search Analytics: 1,200 queries a minute per site and per user, 30,000,000
a day per project (heavy queries, e.g. long ranges grouped by page and query, cost more load quota). URL Inspection:
2,000 a day and 600 a minute per property. Exhausted quota is `rate_limited`.

## Quick Start
```bash
GOOGLE_REFRESH_TOKEN=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... graphrt run google-search-console/example.yaml --plugins .
```
Set `site_url` in [`example.yaml`](example.yaml) to one of your properties.

## Usage
```yaml
- id: pages
  type: google-search-console.query_search_analytics
  site_url: "https://www.example.com/"
  start_date: "2026-10-01"
  end_date: "2026-10-31"
  dimensions: [page, device]
  dimension_filter_groups: [{ filters: [{ dimension: country, operator: equals, expression: idn }] }]
  limit: 100
- id: inspect
  type: google-search-console.inspect_url
  site_url: "https://www.example.com/"
  inspection_url: "https://www.example.com/produk/sepatu"
```

## Agent policy
- Reads (sites, sitemaps, search analytics, URL inspection) are tools. Search Analytics and URL Inspection are
  POSTs that only read, declared `idempotent`, so they are retried after timeouts and 5xx.
- `submit_sitemap` and `add_site` are tools only with `GOOGLE_SEARCH_CONSOLE_TOOL_ALLOW_WRITES=1`.
- `delete_site` and `delete_sitemap` are node only.
- `api_request` is GET-only for agents. Search Console has no secret-bearing GET endpoints, so no further path
  allowlist is needed.

## Per-user tokens (multi-user agents)

Set `GOOGLE_SEARCH_CONSOLE_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin google-search-console`):

```yaml
tools: [google-search-console/list_sites]
tool_context:
  google-search-console:
    access_token: "{{#start.google_search_console_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is a Google OAuth access token of that user with the scopes this plugin needs.
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `GOOGLE_ACCESS_TOKEN`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_SERVICE_ACCOUNT_JSON` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
Errors are `{"error": {"code", "message", "status", "errors": [{"reason"}]}}`, mapped by `status` (and HTTP
status): `UNAUTHENTICATED`/401 → `auth_error`, `PERMISSION_DENIED`/403 (no access to the property, or the API not
enabled) → `permission_denied`, `NOT_FOUND` → `not_found`, `INVALID_ARGUMENT` → `invalid_input`,
`RESOURCE_EXHAUSTED`/429 → `rate_limited`.

## Testing
```bash
npm test          # from the repo root
```
Generated contract suite plus tests for the opt-in, read retries, paging, error mapping and the per-request scope.
Verified live only with an invalid token (`auth_error`).

## License
Apache-2.0
