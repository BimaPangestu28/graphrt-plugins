# shipper

**Status:** beta · **ToS risk:** none. Official API; checked live only with an invalid key, and one request field placement is unverified. See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Shipper.id](https://shipper.id) logistics API v3
([reference](https://logistics-docs.shipper.id)). It searches locations, compares domestic courier rates, creates
orders, requests pickups, prints labels and tracks orders. Reads, rates and labels are agent tools; creating and
cancelling orders and requesting pickups are workflow nodes only.

## Features
- **Locations:** `search_locations` (by name, any level) and step by step `list_countries` → `list_provinces` →
  `list_cities` → `list_suburbs` → `list_areas` (paginated with `limit`/`cursor`; Indonesia is country 228)
- **`get_domestic_rates`:** prices per courier and service (`rate.id` is what `create_order` needs) for a parcel
  with optional `item_categories` (from Shipper's list: Cairan, Dokumen, Elektronik, Furnitur, Kosmetik, Makanan,
  Minuman, Pakaian, Sepatu, Spare Parts, Aksesoris, Dekorasi Rumah, Mainan, Obat dan Herbal, Garmen dan Tekstil,
  Buku, Lainnya; matched case-insensitively), filter by rate type; `cod_amount` quotes cash-on-delivery couriers
- **Orders:** `create_order` (node only), `get_order` and `get_order_by_external_id` (with `awb_number`,
  `shipment_status` and the tracking history), `cancel_order` (node only)
- **`request_pickup`** (node only): activate orders for pickup; a courier is dispatched
- **`create_label`:** label (LBL) or receipt (RCP) document for orders
- **`api_request`:** any other endpoint, e.g. `/v3/vehicle/city/{city_id}` (GET only for agents)

`search_locations` sends `keyword`, `adm_level` and `limit` as query parameters as described in Shipper's reference;
this placement is not verified against a live account. Shipper has no separate tracking endpoint: tracking is part of the order (`get_order`). Full operation reference:
[OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Shipper API key: sign up for the sandbox at [shipper.id](https://shipper.id) and ask Shipper (sales/support) for
  API access; production keys come after the integration is approved. Sandbox and production keys are different.

## Installation
```bash
graphrt plugin install ./shipper
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `SHIPPER_API_KEY` | yes | API key, sent in the `X-API-Key` header |
| `SHIPPER_ENVIRONMENT` | no | `production` (default, `merchant-api.shipper.id`) or `sandbox` (`merchant-api-sandbox.shipper.id`) |

A node can override the key with `access_token` (from a secret; needs `--trust-plugin shipper`). Agent tools never
can.

## Pricing
API access has no per-call fee; you pay the shipping fees of the orders you create (`payment_type` `postpay` is
invoiced by Shipper, `cash` is paid to the courier), plus COD and insurance fees. Rate quotes, location reads, labels
and order reads are free and retried after 5xx and network errors.

## Quick Start
```bash
SHIPPER_API_KEY=... graphrt run shipper/example.yaml --plugins .
```
The example searches areas named Kebayoran.

## Usage
```yaml
- id: rates
  type: shipper.get_domestic_rates
  origin: { area_id: 4711, lat: "-6.2", lng: "106.8", suburb_id: 482 }
  destination: { area_id: 12345, lat: "-6.9", lng: "107.6", suburb_id: 1030 }
  weight: 1
  package_length: 10
  package_width: 10
  package_height: 5
  item_value: 150000
  item_categories: [Pakaian]
  rate_types: [regular]
- id: order
  type: shipper.create_order
  consignee: { name: Budi, phone_number: "6281200000002", email: budi@example.com }
  consigner: { name: Toko A, phone_number: "6281200000001", email: toko@example.com }
  courier: { rate_id: "{{#rates.data.pricings.0.rate.id#}}", use_insurance: false, cod: false }
  origin: { area_id: 4711, address: Jl. Sudirman 1, lat: "-6.2", lng: "106.8" }
  destination: { area_id: 12345, address: Jl. Asia Afrika 2, lat: "-6.9", lng: "107.6" }
  package: { weight: 1, length: 10, width: 10, height: 5, price: 150000, package_type: 2, items: [{ name: Kemeja, price: 150000, qty: 1 }] }
  external_id: "INV-{{#start.order_id#}}"
```
Weights are kilograms (more than 0), sizes centimeters, values IDR. `request_pickup` and `create_label` take at
most 30 orders per call. `package_length`, `package_width` and `package_height` are sent
as `length`, `width` and `height` (graphrt reserves `width` and `height` on workflow nodes).

## Agent policy
- **Node only:** `create_order`, `cancel_order` and `request_pickup`: they book, cancel or dispatch couriers and cost
  money. They are never retried after an unknown outcome; set `external_id` on orders so
  `get_order_by_external_id` can tell whether an order was created.
- **Agent tools:** locations, rates, order reads and labels.
- `api_request` is GET-only for agents.

## Errors
| Kind | When |
|------|------|
| `auth_error` | 401/403 with code 10001 or 70002 ("Unauthorized Access"): invalid key, or a key of the other environment (check `SHIPPER_ENVIRONMENT`) |
| `invalid_input` | 400/422 with Shipper's `metadata.errors[].message` and code |
| `not_found` | unknown order or location |
| `rate_limited` | 429 (retried) |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus environment, node-only, error-code and paging cases.
Verified live with an invalid key on production and sandbox (clean `auth_error`, 403 code 70002).

## License
Apache-2.0
