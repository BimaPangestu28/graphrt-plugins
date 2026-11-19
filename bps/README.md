# bps

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [BPS Web API](https://webapi.bps.go.id/documentation/)
of Badan Pusat Statistik (Statistics Indonesia): official statistics of Indonesia, its provinces and its
regencies/cities. It is built with the declarative REST layer ([`definition.mjs`](definition.mjs)). Every
operation is a read.

## Features
- **Domains and subjects:** `list_domains` (national `0000`, provinces, regencies/cities), `list_subject_categories`,
  `list_subjects`
- **Dynamic data:** `list_variables`, `list_vertical_variables`, `list_derived_variables`, `list_periods`,
  `list_derived_periods`, `list_units`, `get_dynamic_data`
- **Tables and indicators:** `list_static_tables`, `get_static_table` (HTML table), `list_strategic_indicators`,
  `get_foreign_trade` (export/import by HS code, port and country)
- **Content:** `list_press_releases`, `get_press_release`, `list_publications`, `get_publication`, `search_content`
- **Reference:** `list_glossary`, `list_classifications` (KBLI 2009/2015/2017/2020, KBKI 2015)
- **`api_request`:** any other GET endpoint, e.g. `/v1/api/list/model/infographic/domain/0000` (leave out the
  `/key/...` segment: the key is added as `?key=`)

Lists return BPS's items (`data[1]`) and page by page number: pass `next_cursor` back as `cursor`. `search_content`,
`list_glossary` and `list_classifications` also take `limit` (`perpage`). Full reference: [OPERATIONS.md](OPERATIONS.md).

### Reading dynamic data
1. `list_domains` → `domain_id` (e.g. `0000`, `3200` Jawa Barat, `3273` Kota Bandung).
2. `list_variables` (optionally by `subject`) → `var_id`.
3. `list_periods` with `variable` → `th_id` (an id, not the year: e.g. `124` = 2024).
4. `get_dynamic_data` with `variable` and `periods` (`"124"`, `"123;124"` or `"120:124"`).

The result has the labels (`vervar`, `turvar`, `tahun`, `turtahun`) and `datacontent`, whose keys concatenate the
ids of vertical variable + variable + derived variable + period + derived period, e.g. `9999` + `145` + `289` +
`100` + `0` = `"99991452891000"`.

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- Network access to `webapi.bps.go.id`

## Installation
```bash
graphrt plugin install ./bps
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `BPS_API_KEY` | yes | Web API key (sent as the `key` query parameter, redacted from every error and result) |

**Getting a key (free):** sign up at [webapi.bps.go.id/developer](https://webapi.bps.go.id/developer/), create an
application and copy its key. BPS publishes no per-key price; keep the key private. The documented URLs put the key
in the path (`.../key/<key>/`); the server reads it from the query string as well, which keeps it out of path
templates and logs of the path.

**Attribution:** cite BPS as the source (e.g. "Sumber: Badan Pusat Statistik") when you publish its data.

## Quick Start
```bash
BPS_API_KEY=... graphrt run bps/example.yaml --plugins .
```
The example lists the province domains and the national strategic indicators.

## Usage
```yaml
- id: periods
  type: bps.list_periods
  domain: "0000"
  variable: 145
- id: values
  type: bps.get_dynamic_data
  domain: "0000"
  variable: 145
  periods: "{{#periods.data.0.th_id#}}"
  lang: eng
```

## Agent policy
All operations are public-data reads and are agent tools. `api_request` is GET-only (all BPS endpoints are GET).
Nothing writes, sends or costs money.

## Errors
| Situation | Kind |
|---|---|
| Missing key | `auth_error` (before any request) |
| Invalid key: 401 `{"status":"Error","code":"KEY_MISSING","message":"Invalid API KEY"}` | `auth_error` |
| Bad domain id or parameter (400, e.g. "'domain' parameter ... must be a 4-digit numeric string.") | `invalid_input` |
| Nothing for that domain/id/combination (404, `data-availability: not-available`) | `not_found` |
| `{"status":"Error"}` in a 200 | `api_error` |
| 429 / 5xx / network | `rate_limited` / retried `api_error` / `network_error` |

## API Reference
[OPERATIONS.md](OPERATIONS.md); BPS's OpenAPI spec: <https://webapi.bps.go.id/documentation/openapi.yaml>.

## License
Apache-2.0. BPS data is published by Badan Pusat Statistik under its own terms of use.
