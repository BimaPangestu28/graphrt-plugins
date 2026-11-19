# open-meteo operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `open-meteo.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_forecast` | Weather forecast for a coordinate: current conditions, hourly and daily values for up to 16 days (WMO weather codes; units in *_units) | **latitude**, **longitude**, current, hourly, daily, timezone, forecast_days, past_days, temperature_unit, wind_speed_unit, precipitation_unit |
| `search_locations` | Find places by name (city, town or postal code) to get their coordinates, time zone, country and population; null when nothing matches | **name**, count, language, country_code |
| `api_request` | Call any Open-Meteo forecast API endpoint that has no dedicated operation, e.g. path "/v1/forecast". Only the API's own host is allowed. | method, **path**, query, body |
