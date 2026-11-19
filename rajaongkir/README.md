# rajaongkir

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the current
[RajaOngkir API by Komerce](https://rajaongkir.com/docs) (`rajaongkir.komerce.id`). The old `api.rajaongkir.com`
Starter/Basic/Pro API was retired when RajaOngkir moved to Komerce, and its keys do not work here. The plugin quotes
shipping costs of Indonesian couriers, searches destinations and tracks waybills. Every operation is a read, a
workflow node and an agent tool.

## Features
- **Destinations:** `search_domestic_destinations` (city, district, village or postal code; paginated with
  `limit`/`cursor`), `search_international_destinations` (countries), and step by step `list_provinces` →
  `list_cities` → `list_districts` → `list_subdistricts`
- **Costs:** `calculate_domestic_cost` (ids from the destination search), `calculate_district_cost` (district ids),
  `calculate_international_cost`; each returns one row per courier service: `name`, `code`, `service`,
  `description`, `cost` (IDR), `etd`
- **`track_waybill`:** status, summary, delivery status and manifest history of a waybill (resi)
- **`api_request`:** any other endpoint (GET only for agents)

Couriers are codes joined by `:`, e.g. `jne:sicepat:jnt:anteraja:pos:tiki:ninja:lion:sap:wahana:ide:sentral:rex:spx`
(see [courier availability](https://rajaongkir.com/docs/shipping-cost/getting_started/courier_availability);
international: `jne`, `pos`, `tiki`). Weights are grams. Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A RajaOngkir (Komerce) account from [rajaongkir.com](https://rajaongkir.com) and its Shipping Cost API key from the
  dashboard ([how to get the key](https://rajaongkir.com/docs/shipping-cost/getting_started/apikey))

## Installation
```bash
graphrt plugin install ./rajaongkir
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `RAJAONGKIR_API_KEY` | yes | Shipping Cost API key, sent in the `key` header |

A node can override the key with `access_token` (from a secret; needs `--trust-plugin rajaongkir`). Agent tools never
can.

## Pricing
Plans limit API hits per day (at the time of writing): **Starter** free, 100 hits a day; **Pro** Rp149.000/month,
25,000; **Enterprise** Rp249.000/month, 50,000 (prices include VAT; see [rajaongkir.com](https://rajaongkir.com)).
Calls are not billed one by one, so quotes (POSTs that only read) and tracking are retried after 5xx and network
errors; each retry uses one more hit. Whether `track_waybill` is available on every plan is not stated in the docs.

## Quick Start
```bash
RAJAONGKIR_API_KEY=... graphrt run rajaongkir/example.yaml --plugins .
```
The example finds Coblong (Bandung) and postal code 12440 (Jakarta) and quotes JNE, SiCepat and J&T for 1 kg.

## Usage
```yaml
- id: track
  type: rajaongkir.track_waybill
  awb: "{{#start.resi#}}"
  courier: jne
  last_phone_number: "12345"
```
- `awb` and `courier` go in the query string and `last_phone_number` (last 5 digits of the receiver's phone, needed
  for JNE) in the form body, as in RajaOngkir's example request.
- `calculate_district_cost` uses ids from `list_districts`; the other quotes use ids from
  `search_domestic_destinations` (and `search_international_destinations` for the country).

## Agent policy
All operations are reads (cost quotes and tracking change nothing) and available to agents as tools. An agent can use
up a Starter plan's 100 daily hits quickly. `api_request` is GET-only for agents.

## Errors
| Kind | When |
|------|------|
| `auth_error` | invalid or unknown key (RajaOngkir answers HTTP 400 "Invalid Api key, key not found"; mapped by the plugin) |
| `invalid_input` | other 400s and 422 (missing parameter, invalid courier, cost not found); RajaOngkir's `meta.message` is included |
| `not_found` | 404: no destination or waybill data |
| `rate_limited` | 429 (retried) |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus header, invalid-key mapping and not-found cases.
Verified live with an invalid key (clean `auth_error`: "Invalid Api key, key not found").

## License
Apache-2.0
