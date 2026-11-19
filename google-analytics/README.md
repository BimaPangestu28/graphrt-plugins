# google-analytics

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for Google Analytics 4: reports through the
[Data API v1beta](https://developers.google.com/analytics/devguides/reporting/data/v1/rest) and account, property
and data stream discovery through the [Admin API v1beta](https://developers.google.com/analytics/devguides/config/admin/v1/rest).
It is read-only. Universal Analytics properties are not supported (Google shut them down).

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs). Google
credentials use the same auth files as `google-sheets` (google-auth, google-token-endpoint and service-account,
copied unchanged into [`lib/`](lib/)) through [`lib/google-rest-auth.mjs`](lib/google-rest-auth.mjs), copied
unchanged from `google-docs`. [`lib/report-fields.mjs`](lib/report-fields.mjs) lets reports take plain
dimension and metric names.

## Features
- **`run_report`:** dimensions × metrics over up to 4 date ranges, with dimension and metric filters, sorting,
  `limit`/`offset` (up to 250,000 rows; `rowCount` gives the total), totals (`metric_aggregations`), comparisons,
  cohorts and currency
- **`run_realtime_report`:** the last 30 minutes (60 for Analytics 360), up to 2 minute ranges
- **`run_pivot_report`:** pivot tables
- **`batch_run_reports`:** up to 5 reports in one call (each item uses the API's field names: `dateRanges`,
  `orderBys`, ...)
- **`get_metadata`:** every dimension and metric of a property, including custom ones (`property_id: "0"` for the
  common ones only)
- **`check_compatibility`:** which dimensions and metrics can be combined
- **`list_account_summaries`**, **`list_properties`**, **`get_property`**, **`list_data_streams`:** find property
  ids, time zones, currencies and measurement ids (Admin API)
- **`api_request`:** any other Data API endpoint (GET only for agents)

`dimensions` and `metrics` take names (`[country, activeUsers]`) or the API's objects (`{"name": "conversionRate",
"expression": "..."}`). Dates are `YYYY-MM-DD`, `today`, `yesterday` or `NdaysAgo`. Metric values come back as
strings in `rows[].metricValues[].value`. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Google Cloud project with the **Google Analytics Data API** and the **Google Analytics Admin API** enabled

## Installation
```bash
graphrt plugin install ./google-analytics
```

## Configuration
| Env var | Purpose |
|---|---|
| `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth refresh trio (scope `analytics.readonly`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Path to a service account key file; add the service account's email as a Viewer of each property (Admin → Property access management) |
| `GOOGLE_ACCESS_TOKEN` | A ready access token (used only when neither of the above is set) |

Credential order: a node's `access_token` (needs `--trust-plugin google-analytics`), then the refresh trio, then the
service account, then `GOOGLE_ACCESS_TOKEN`. `GOOGLE_ACCESS_TOKEN` is ignored whenever a grant is configured (the
plugin cannot refresh after a 401). Grant tokens are cached in memory until a minute before they expire.

### Getting the credentials
1. Google Cloud console: enable the Google Analytics Data API and the Google Analytics Admin API.
2. Either create an OAuth client and get a refresh token for `https://www.googleapis.com/auth/analytics.readonly`,
   or create a service account, download a JSON key and give its `client_email` the Viewer role on the GA4
   property (or account).

**Pricing / limits:** the APIs are free; each report costs quota tokens (more for long ranges and many
dimensions). Standard properties get 200,000 tokens a day and 40,000 an hour per property, 14,000 an hour per
project and property, and 10 concurrent requests; Analytics 360 gets more. Pass `return_property_quota: true` to
see what is left. Exhausted quota is `rate_limited`.

## Quick Start
```bash
GOOGLE_REFRESH_TOKEN=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... graphrt run google-analytics/example.yaml --plugins .
```
Set `property_id` in [`example.yaml`](example.yaml) to one of your properties. `property_id` is the numeric id (`123456789`) or the
resource name (`properties/123456789`); measurement ids like `G-ABC123` and other values are refused before any
request.

## Usage
```yaml
- id: top_pages
  type: google-analytics.run_report
  property_id: "{{#start.property#}}"
  dimensions: [pagePath]
  metrics: [screenPageViews, activeUsers]
  date_ranges: [{ startDate: 28daysAgo, endDate: yesterday }]
  dimension_filter: { filter: { fieldName: country, stringFilter: { value: Indonesia } } }
  order_bys: [{ metric: { metricName: screenPageViews }, desc: true }]
  limit: 20
- id: now
  type: google-analytics.run_realtime_report
  property_id: "{{#start.property#}}"
  metrics: [activeUsers]
```

## Agent policy
Every operation only reads and is an agent tool. The report methods are POSTs, declared `idempotent` because they
change nothing, so they are retried after timeouts and 5xx. `api_request` is GET-only for agents and reaches only
the Data API host.

## Errors
Errors are `{"error": {"code", "message", "status"}}`, mapped by `status`: `UNAUTHENTICATED` → `auth_error`,
`PERMISSION_DENIED` → `permission_denied` (no access to the property, or an API not enabled), `NOT_FOUND` →
`not_found`, `INVALID_ARGUMENT` (unknown or incompatible fields: use `check_compatibility`) → `invalid_input`,
`RESOURCE_EXHAUSTED`/429 (quota tokens) → `rate_limited`. Empty or non-name `dimensions`/`metrics` items are
refused before any request.

## Testing
```bash
npm test          # from the repo root
```
Generated contract suite plus tests for the name shorthand, retries and error mapping. Verified live only with an
invalid token (`auth_error`).

## License
Apache-2.0
