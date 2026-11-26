# biteship

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for [Biteship](https://biteship.com/en/docs/api), an
Indonesian shipping aggregator (JNE, J&T, SiCepat, AnterAja, Ninja, Gojek, Grab, Lalamove, ...). It compares courier
rates, finds area ids, books couriers (orders), cancels them and tracks shipments. Reads and rate checks are agent
tools; booking and cancelling are workflow nodes only.

## Features
- **`get_rates`:** prices and ETAs from the couriers you list, between two places given as area ids, postal codes
  or coordinates (instant couriers need coordinates), with insurance and COD options
- **`list_couriers`:** couriers and services enabled for the account
- **`search_areas`:** area ids by name or postal code
- **`create_order`** (node only): book a courier for a shipment; the fee is charged to your Biteship balance
- **`get_order`**, **`cancel_order`** (node only), **`list_cancellation_reasons`**
- **`get_tracking`:** tracking of an order booked through Biteship (`courier.tracking_id`)
- **`track_waybill`:** public tracking of any waybill (resi) by courier code, also for shipments booked elsewhere
- **`api_request`:** any other endpoint, e.g. `/v1/locations` (GET only for agents)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Biteship account and an API key from the dashboard (Settings > API Keys). Test keys start with
  `biteship_test.`, live keys with `biteship_live.`; both use `api.biteship.com`.

## Installation
```bash
graphrt plugin install ./biteship
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `BITESHIP_API_KEY` | yes | API key, sent as the `Authorization` header |

A node can override the key with `access_token` (from a secret; needs `--trust-plugin biteship`). Agent tools never
can.

## Pricing
- **Orders:** each booking costs the courier's shipping fee (plus insurance or COD fees), taken from the Biteship
  balance; plans also limit the number of orders a month.
- **Rate checks:** plans include a monthly quota (Starter 0, Grow 10,000, Scale 50,000 at the time of writing);
  beyond it each `get_rates` call costs Rp5 from Bitepoints ([plans](https://biteship.com/en/docs/plans)).
- Test-key requests do not count against quotas.

## Quick Start
```bash
BITESHIP_API_KEY=biteship_test.... graphrt run biteship/example.yaml --plugins .
```
The example finds the area id of Kebayoran Baru.

## Usage
```yaml
- id: rates
  type: biteship.get_rates
  origin_postal_code: 12440
  destination_postal_code: 40111
  couriers: jne,sicepat,jnt,anteraja
  items:
    - { name: Kemeja, value: 150000, quantity: 1, weight: 300 }
- id: book
  type: biteship.create_order
  origin_contact_name: Toko A
  origin_contact_phone: "08120000001"
  origin_address: Jl. Sudirman 1, Jakarta
  origin_postal_code: 12440
  destination_contact_name: Budi
  destination_contact_phone: "08120000002"
  destination_address: Jl. Asia Afrika 2, Bandung
  destination_postal_code: 40111
  courier_company: "{{#rates.data.0.courier_code#}}"
  courier_type: "{{#rates.data.0.courier_service_code#}}"
  delivery_type: now
  reference_id: "INV-{{#start.order_id#}}"
  items:
    - { name: Kemeja, value: 150000, quantity: 1, weight: 300 }
```
Weights are grams, sizes centimeters, values IDR.

## Agent policy
- **Node only:** `create_order` (spends the balance and dispatches a courier) and `cancel_order`.
- **Agent tools:** every read and `get_rates`. A rate check changes nothing but may be billed, so it is never retried
  after a 5xx, timeout or network error (`retryable: false`, outcome unknown).
- `create_order` is never retried after an unknown outcome either. Always set `reference_id`: Biteship refuses a
  duplicate and returns the existing order id, so a retry with the same `reference_id` cannot book twice.
- `api_request` is GET-only for agents.

## Errors
| Kind | When |
|------|------|
| `auth_error` | code 40000001 (an invalid key answers HTTP 400 "Authentication for your key is failed"), or 401 |
| `permission_denied` | 402 / code 40200000: quota used up and the balance cannot cover it; 403 |
| `invalid_input` | 400/422: missing or bad fields (Biteship's message is included) |
| `not_found` | unknown order, tracking or waybill |
| `rate_limited` | 429 (retried) |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus header, node-only, error-code and no-retry cases.
Verified live with an invalid key (clean `auth_error`).

## License
Apache-2.0
