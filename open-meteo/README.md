# open-meteo

**Status:** stable · **ToS risk:** none. Public no-auth API; the example read a real Jakarta forecast live (PR #27, rechecked 2026-11-19). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the free [Open-Meteo](https://open-meteo.com) weather
API. It finds places by name and returns weather forecasts (current conditions, hourly and daily values for up to
16 days). No account or API key is needed. Every operation is a workflow node and an agent tool.

It is also the reference plugin for the declarative REST layer: the whole plugin is the data in
[`definition.mjs`](definition.mjs). See [docs/declarative-plugins.md](../docs/declarative-plugins.md).

## Features
- **`search_locations`:** place name or postal code to coordinates, time zone, country, admin regions and
  population (filter by country, choose the language)
- **`get_forecast`:** forecast for a coordinate. By default it returns current temperature, humidity, feels-like
  temperature, precipitation, weather code and wind, plus a daily summary (weather code, min/max temperature,
  precipitation sum and probability) in the location's own time zone. Any Open-Meteo variable can be requested
  through `current`, `hourly` and `daily`.
- **`api_request`:** any other endpoint on `api.open-meteo.com`, e.g. `/v1/forecast` with `minutely_15` (GET only
  when called by an agent)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- Network access to `api.open-meteo.com` and `geocoding-api.open-meteo.com`

## Installation
```bash
graphrt plugin install ./open-meteo
```
No `npm install` needed: the plugin has no dependencies.

## Runtime: Node.js or WebAssembly
This plugin runs on Node.js (the release tarball, above). A sandboxed WebAssembly build with the same nodes, tools,
env variables, results and errors is in [`wasm/open-meteo`](../wasm/open-meteo/): no Node.js process, cold runs ~6× faster
(≈18–24 ms instead of ≈110 ms) and ~12× less memory on a warm server, but 1–3 ms slower per warm call. Install one
of the two (same plugin name):

```bash
graphrt plugin install https://github.com/Graphrt/graphrt-plugins --rev main --subdir wasm/open-meteo
```
The release catalog lists the build in the plugin's `runtimes`. Differences and measurements:
[wasm/README.md](../wasm/README.md#picking-a-runtime).

## Configuration
None. The plugin reads no environment variables and asks for no secrets.

**Terms:** the free API is for non-commercial use, with a fair-use limit of about 10,000 calls a day (and 5,000 an
hour, 600 a minute). Commercial use needs an Open-Meteo API plan, which this plugin does not support yet. Data is
CC BY 4.0: credit Open-Meteo when you publish it.

## Quick Start
```bash
graphrt run open-meteo/example.yaml --plugins .
```
The example finds Jakarta and prints its current weather and a 3-day daily summary.

## Usage
```yaml
- id: place
  type: open-meteo.search_locations
  name: "{{#start.city#}}"
  count: 1
- id: forecast
  type: open-meteo.get_forecast
  latitude: "{{#place.data.0.latitude#}}"
  longitude: "{{#place.data.0.longitude#}}"
  hourly: [temperature_2m, precipitation_probability]
  forecast_days: 2
  wind_speed_unit: ms
```

- `data` of `search_locations` is the list of matching places, or `null` when nothing matches.
- `data` of `get_forecast` is Open-Meteo's response: `current`, `hourly` and `daily` hold the values (each daily
  or hourly variable is an array aligned with `time`), and `*_units` the units.
- `weather_code` values are [WMO codes](https://open-meteo.com/en/docs#weather_variable_documentation)
  (0 clear, 1–3 partly cloudy to overcast, 45/48 fog, 51–67 drizzle and rain, 71–77 snow, 80–82 showers, 95–99
  thunderstorm).
- Coordinates out of range and `forecast_days` above 16 are refused before any request. Unknown variable names are
  reported by Open-Meteo as `invalid_input` with its reason.

## Agent policy
All operations are reads and are available to agents as tools. `api_request` is GET-only for agents.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus Open-Meteo-specific cases. Verified live with a real
read (`graphrt run open-meteo/example.yaml --plugins .`).

## License
Apache-2.0
