# bmkg

**Status:** stable · **ToS risk:** none. Public no-auth API; the example read real data live (rechecked 2026-11-19). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the open data of
[BMKG](https://data.bmkg.go.id) (Badan Meteorologi, Klimatologi, dan Geofisika), Indonesia's meteorology,
climatology and geophysics agency. It returns the latest earthquake, the last 15 M5.0+ and felt earthquakes,
3-day weather forecasts per village (kelurahan/desa, Kemendagri adm4 code) and active nowcast weather warnings. No
account or API key is needed. Every operation is a workflow node and an agent tool.

> **Attribution is required.** BMKG's terms: *"Wajib untuk mencantumkan BMKG (Badan Meteorologi, Klimatologi, dan
> Geofisika) sebagai sumber data dan menampilkannya pada aplikasi/sistem Anda."* You must credit BMKG as the data
> source and show that credit in your app or system. Every operation description repeats this so agents pass it
> on; keep "Source: BMKG" in any answer, page or message built from this data.

## Features
- **Earthquakes** (from `data.bmkg.go.id/DataMKG/TEWS/*.json`, updated within minutes):
  - `get_latest_earthquake`: date, time (WIB) and UTC `DateTime`, coordinates, magnitude, depth, region, tsunami
    potential, felt intensity, plus `shakemap_url` (the shakemap image on `data.bmkg.go.id`)
  - `list_recent_earthquakes`: the last 15 earthquakes of M5.0+, with tsunami potential
  - `list_felt_earthquakes`: the last 15 felt earthquakes, with where and how strongly (MMI) they were felt
- **Weather:** `get_weather_forecast` for one adm4 code (e.g. `31.71.03.1001`, Kemayoran, Jakarta Pusat): the
  location (province, regency, district, village, coordinates, time zone) and a flat, time-ordered list of
  3-hourly forecasts for 3 days: `t` (°C), `hu` (%), `weather_desc` / `weather_desc_en`, `ws` (km/h), `wd`, `tcc`
  (%), `tp` (mm), `vs_text`, `local_datetime`, `utc_datetime`, icon `image`
- **Warnings** (nowcast, `www.bmkg.go.id/alerts/nowcast`): `list_weather_warnings` parses the RSS feed of active
  provincial warnings (title, affected districts, `alert_code`, publish time); `get_weather_warning` parses one
  warning's CAP 1.2 document (event, urgency, severity, certainty, effective/expires, infographic URL, area and,
  with `include_polygons: true`, its polygons as `[latitude, longitude]` pairs). `language` is `id` or `en`.
- **`api_request`:** any other file on `data.bmkg.go.id`, e.g. `/DataMKG/TEWS/autogempa.json` (GET only for agents)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

**Finding an adm4 code:** codes follow Kepmendagri No. 100.1.1-6117 Tahun 2022 (province.regency.district.village,
`NN.NN.NN.NNNN`). Use the `wilayah-indonesia` plugin to search villages by name. Malformed codes are refused before
any request; an unknown code is BMKG's `not_found` ("Data cuaca tidak ditemukan"). BMKG serves only village-level
forecasts (adm1–adm3 are not accepted).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- Network access to `data.bmkg.go.id`, `api.bmkg.go.id` and `www.bmkg.go.id`

## Installation
```bash
graphrt plugin install ./bmkg
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
None. The plugin reads no environment variables and asks for no secrets.

**Limits:** 60 requests per minute per IP (BMKG). A 429 is `rate_limited`. Forecasts are refreshed about twice a
day, earthquake files within minutes of an event; poll no more than you need.

## Quick Start
```bash
graphrt run bmkg/example.yaml --plugins .
```
The example prints the latest earthquake and the next forecast step for Kemayoran, Jakarta.

## Usage
```yaml
- id: quakes
  type: bmkg.list_felt_earthquakes
- id: warnings
  type: bmkg.list_weather_warnings
  language: en
- id: detail
  type: bmkg.get_weather_warning
  language: en
  alert_code: "{{#warnings.data.warnings.0.alert_code#}}"
```
Earthquake fields keep BMKG's (Indonesian) names: `Tanggal`, `Jam`, `DateTime`, `Coordinates`, `Lintang`, `Bujur`,
`Magnitude`, `Kedalaman`, `Wilayah`, `Potensi`, `Dirasakan`, `Shakemap`.

## Agent policy
All operations are public reads and are available to agents as tools. `api_request` is GET-only for agents. Tool
results are truncated at 100,000 characters (nodes get everything).

## Errors
- `invalid_input`: malformed adm4 code, an `alert_code` that is not letters and digits, a `language` other than `id`/`en`, or BMKG's 400 ("Parameter adm tidak valid")
- `not_found`: unknown village code or warning
- `rate_limited`: over 60 requests a minute
- `api_error`: the warning feed or CAP document came back as something other than XML (e.g. an HTML error page), or a response body over 2 MB (refused while streaming, never parsed, not retried)

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus shaping and validation cases;
`test/nowcast-xml.test.mjs` covers the RSS/CAP readers. Verified live with a real read
(`graphrt run bmkg/example.yaml --plugins .`).

## License
Apache-2.0. Data © BMKG; credit BMKG as the source.
