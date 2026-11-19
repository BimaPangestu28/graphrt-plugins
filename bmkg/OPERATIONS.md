# bmkg operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `bmkg.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_latest_earthquake` | The most recent earthquake BMKG reported in Indonesia: time (WIB and UTC DateTime), coordinates, magnitude, depth, region, tsunami potential, felt intensity (MMI) and shakemap_url. Source: BMKG (Badan Meteorologi, Klimatologi, dan Geofisika); credit BMKG when showing it |  |
| `list_recent_earthquakes` | The last 15 earthquakes of magnitude 5.0 or more in and around Indonesia, newest first, with tsunami potential. Source: BMKG (Badan Meteorologi, Klimatologi, dan Geofisika); credit BMKG when showing it |  |
| `list_felt_earthquakes` | The last 15 earthquakes people felt (any magnitude), newest first, with where and how strongly (MMI scale) they were felt. Source: BMKG (Badan Meteorologi, Klimatologi, dan Geofisika); credit BMKG when showing it |  |
| `get_weather_forecast` | 3-day weather forecast for one village/kelurahan (Kemendagri adm4 code, e.g. 31.71.03.1001 Kemayoran) in 3-hour steps: temperature t (°C), humidity hu (%), weather_desc/weather_desc_en, wind ws (km/h) and wd, cloud cover tcc (%), rain tp (mm), visibility vs_text, local_datetime. Source: BMKG (Badan Meteorologi, Klimatologi, dan Geofisika); credit BMKG when showing it | **adm4** |
| `list_weather_warnings` | Active nowcast weather warnings (heavy rain, thunderstorms, strong wind) per province, with each warning's alert_code for get_weather_warning. Source: BMKG (Badan Meteorologi, Klimatologi, dan Geofisika); credit BMKG when showing it | **language** |
| `get_weather_warning` | One nowcast warning (CAP): event, urgency, severity, certainty, effective/expires times, affected districts, infographic URL and optionally the area polygons. Source: BMKG (Badan Meteorologi, Klimatologi, dan Geofisika); credit BMKG when showing it | **language**, **alert_code**, include_polygons |
| `api_request` | Call any BMKG open data endpoint that has no dedicated operation, e.g. path "/DataMKG/TEWS/autogempa.json". Only the API's own host is allowed. | method, **path**, query, body |
