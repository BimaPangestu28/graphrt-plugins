# google-maps-platform

**Status:** beta · **ToS risk:** none. Official Maps Platform APIs (billed per call); checked live only with an invalid key (API_KEY_INVALID). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for three Google Maps Platform APIs with one API key:
[Places API (New)](https://developers.google.com/maps/documentation/places/web-service/op-overview),
[Geocoding API v4](https://developers.google.com/maps/documentation/geocoding/geocoding-v4-overview) and
[Routes API](https://developers.google.com/maps/documentation/routes). Every operation is a workflow node and an
agent tool.

> **Billing warning:** every call is billed by Google once the monthly free cap of its SKU is used, and the fields
> you ask for decide the SKU. See Pricing before you give these tools to an agent.

## Features
- **Places:** `search_text` (text query with type, open-now, rating, price and location filters; paginated with
  `limit`/`cursor`), `search_nearby` (types within a radius), `get_place` (details by id), `autocomplete_places`
  (predictions with session tokens), `get_place_photo` (a short-lived `photoUri` for a photo name)
- **Geocoding v4:** `geocode_address`, `reverse_geocode`
- **Routes:** `compute_routes` (distance, duration, optional alternatives, intermediates, avoid tolls/highways/ferries),
  `compute_route_matrix` (every origin-destination pair, billed per element)

Waypoints are Routes API objects: `{"address": "Monas, Jakarta"}`, `{"placeId": "ChIJ..."}` or
`{"location": {"latLng": {"latitude": -6.17, "longitude": 106.82}}}`; matrix entries wrap them as `{"waypoint": ...}`.
Durations are strings such as `"540s"`. Full operation reference: [OPERATIONS.md](OPERATIONS.md).

There is no `api_request`: every endpoint is billed and needs a field mask, so each one is an explicit operation.

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Google Cloud project with billing enabled and Places API (New), Geocoding API and Routes API enabled
- An API key ([Credentials](https://console.cloud.google.com/apis/credentials)). Restrict it to these three APIs (API
  restrictions) and, for a server, to its IP addresses.

## Installation
```bash
graphrt plugin install ./google-maps-platform
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `GOOGLE_MAPS_API_KEY` | yes | API key, sent as the `X-Goog-Api-Key` header (never in the URL) |
| `GOOGLE_MAPS_TOOL_MAX_MATRIX_ELEMENTS` | no | Most elements (origins x destinations) an agent may request in one `compute_route_matrix` call (default 100) |
| `GOOGLE_MAPS_TOOL_ALLOW_EXPENSIVE_FIELDS` | no | `1` lets agents request any field (`*`, rating, phone, website, opening hours, reviews, photos, ...) in `search_text`, `search_nearby` and `get_place`; without it agents get Essentials/Pro fields only |

A node can override the key with `access_token` (from a secret; needs `--trust-plugin google-maps-platform`). Agent
tools never can.

## Pricing
Prices per 1,000 calls at the lowest volume tier, with the monthly free calls per SKU, at the time of writing
([pricing](https://developers.google.com/maps/billing-and-pricing/pricing)):

| Operation | SKU (free/month, price per 1,000) |
|-----------|-----------------------------------|
| `search_text`, `search_nearby` | Pro with the default fields (5,000; $32); Enterprise if you add rating, phone, website or hours (1,000; $35) |
| `get_place` | Essentials for ids/address only (10,000; $5), Pro with the default fields (5,000; $17), Enterprise (1,000; $20) |
| `autocomplete_places` | Autocomplete Requests (10,000; $2.83); free when the session ends in a `get_place` with the same `session_token` |
| `get_place_photo` | Place Details Photos (1,000; $7) |
| `geocode_address`, `reverse_geocode` | Geocoding (10,000; $5) |
| `compute_routes` | Essentials (10,000; $5); Pro with traffic-aware routing, 11+ intermediates or modifiers (5,000; $10) |
| `compute_route_matrix` | per **element**: Essentials (10,000; $5), Pro with traffic (5,000; $10) |

Each operation sends `X-Goog-FieldMask` with a cheap default (`field_mask` changes it). Set budget alerts and
per-API quotas in the Google Cloud console.

## Quick Start
```bash
GOOGLE_MAPS_API_KEY=AIza... graphrt run google-maps-platform/example.yaml --plugins .
```
The example geocodes Monas in Jakarta.

## Usage
```yaml
- id: places
  type: google-maps-platform.search_text
  text_query: "nasi goreng near Blok M"
  open_now: true
  field_mask: "places.id,places.displayName,places.formattedAddress,places.rating,nextPageToken"
  limit: 10
- id: route
  type: google-maps-platform.compute_routes
  origin: { address: "Blok M, Jakarta" }
  destination: { placeId: "{{#places.data.0.id#}}" }
  travel_mode: TWO_WHEELER
```

## Agent policy
All operations are agent tools: they read map data and change nothing in the account. Because each call is billed:
- every operation is **never retried after a 5xx, timeout or network error** (Google may already have billed it);
  the error is `retryable: false`, says the outcome is unknown and to check APIs & Services > Metrics. 429s are
  retried;
- agent `compute_route_matrix` calls are limited to `GOOGLE_MAPS_TOOL_MAX_MATRIX_ELEMENTS` elements (default 100);
  nodes get Google's limits (625 elements; 100 with transit or `TRAFFIC_AWARE_OPTIMAL`);
- agent `field_mask`s of `search_text`, `search_nearby` and `get_place` may only name Essentials/Pro fields: `id`,
  `name`, `displayName`, `formattedAddress`, `shortFormattedAddress`, `addressComponents`, `adrFormatAddress`,
  `postalAddress`, `location`, `viewport`, `plusCode`, `types`, `primaryType`, `primaryTypeDisplayName`,
  `businessStatus`, `googleMapsUri`, `googleMapsLinks`, `utcOffsetMinutes`, `iconBackgroundColor`, `iconMaskBaseUri`,
  `accessibilityOptions`, `containingPlaces`, `pureServiceAreaBusiness`, `subDestinations`, `attributions` (under
  `places.` for searches, plus `nextPageToken`). `*`, `places` and Enterprise/Atmosphere fields (rating, phone,
  website, opening hours, price level, reviews, editorial summary, photos, ...) are refused with `permission_denied`
  unless `GOOGLE_MAPS_TOOL_ALLOW_EXPENSIVE_FIELDS=1`. Nodes may request any field;
- `get_place_photo` only accepts photo names of the form `places/<place id>/photos/<photo id>` (nodes and agents).

## Errors
| Kind | When |
|------|------|
| `auth_error` | 400 `API_KEY_INVALID` / `API_KEY_EXPIRED`, or no key |
| `permission_denied` | 403: the API is not enabled for the project (`SERVICE_DISABLED`), billing is off, or the key's restrictions block it; an agent matrix over the element limit; an agent field mask with expensive fields |
| `rate_limited` | 429 `RATE_LIMIT_EXCEEDED` / `RESOURCE_EXHAUSTED` (retried) |
| `invalid_input` | 400 `INVALID_ARGUMENT`: bad field mask, missing field mask, bad waypoint, too many elements; a `photo_name` that is not `places/<id>/photos/<id>` |
| `not_found` | unknown place id |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus field mask defaults, the agent field allowlist,
photo names, paging, error-code and matrix limit cases. Verified live with an invalid key (clean `auth_error`, `API_KEY_INVALID`).

## License
Apache-2.0
