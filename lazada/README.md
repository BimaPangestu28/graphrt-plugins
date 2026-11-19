# lazada

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the
[Lazada Open Platform](https://open.lazada.com) seller APIs: seller, products, orders and order items, plus price,
stock and fulfilment (pack, ready to ship) as workflow nodes. Every request is signed with your app secret
(HMAC-SHA256, [`lib/signing.mjs`](lib/signing.mjs)) and sent to the seller's regional gateway.

It is hand-written on the shared client ([`lib/client.mjs`](lib/client.mjs)) rather than declarative: Lazada's
signature goes into the query string and covers the form body, which the declarative layer's custom auth (headers
only) cannot express.

## Features
- **Seller:** `get_seller`
- **Products:** `list_products` (filter, SKUs, dates), `get_product` (by `item_id` or `seller_sku`)
- **Orders:** `list_orders` (created/updated window, status), `get_order`, `get_order_items`,
  `get_multiple_order_items` (up to 50 orders)
- **Node only:** `update_price_quantity`, `update_sellable_stock` (up to 50 SKUs, sent as Lazada's XML payload),
  `pack_order` (`/order/fulfill/pack`), `ready_to_ship` (`/order/package/rts`)
- **`api_request`:** any other API path (signed; agents: GET and read paths only), e.g. `/finance/transaction/details/get`

Lists page by offset: pass `next_cursor` back as `cursor`. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Lazada Open Platform app (seller in-house or ISV) authorized by the seller

## Installation
```bash
graphrt plugin install ./lazada
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `LAZADA_APP_KEY` | yes | Numeric App Key |
| `LAZADA_APP_SECRET` | yes | App Secret (signs every request; never sent) |
| `LAZADA_ACCESS_TOKEN` | yes | The seller's access token (a node may pass `access_token` instead) |
| `LAZADA_REGION` | yes | Seller country: `id` (api.lazada.co.id), `my`, `ph`, `sg`, `th` or `vn` |

**Getting credentials:** open.lazada.com → App Console → create an app → App Key and App Secret. The seller
authorizes the app (OAuth on auth.lazada.com) and you exchange the code for an access token; tokens expire (about 7
to 30 days) and are refreshed with the refresh token. Token exchange and refresh are not part of this plugin, so
store the current token in `LAZADA_ACCESS_TOKEN` (or pass it as a node's `access_token`). The app needs the API
groups you call (Product, Order, Fulfillment) approved.

**Pricing:** the Open Platform is free for sellers; calls are rate limited per app and API (`ApiCallLimit` is
`rate_limited`, reads are retried).

## Quick Start
```bash
LAZADA_APP_KEY=... LAZADA_APP_SECRET=... LAZADA_ACCESS_TOKEN=... LAZADA_REGION=id graphrt run lazada/example.yaml --plugins .
```
The example reads the seller and the five newest pending orders.

## Usage
```yaml
- id: restock
  type: lazada.update_sellable_stock
  skus: [{ seller_sku: "KOPI-1KG", sellable_quantity: 40 }]
- id: pack
  type: lazada.pack_order
  pack_request:
    pack_order_list: [{ order_id: 123456789, order_item_list: [111, 112] }]
    delivery_type: dropship
    shipping_allocate_type: TFS
```
`pack_request` and `ready_to_ship_request` are passed through as Lazada's `packReq` / `readyToShipReq` JSON; see
the Fulfillment API docs for their fields.

## Agent policy
- **Reads** are agent tools (orders contain buyer names and addresses).
- **Node only:** `update_price_quantity`, `update_sellable_stock`, `pack_order`, `ready_to_ship`: the same ruling
  as the Shopee plugin, a person decides in a workflow when prices, stock and shipments change.
- `api_request` is GET-only for agents and limited to read paths: `/seller/get`, `/products/get`, `/product/item/get`, `/orders/get`, `/order/get`, `/order/items/get`, `/orders/items/get` and `/finance/.../get`. The gateway picks the API from the path, not the HTTP method, so a GET to `/order/cancel` could still cancel; `/auth/*` is refused too. Every response is redacted (app secret, token).

## Errors
Lazada answers failures with HTTP 200 and `{type, code, message, request_id}`; the message shows the code and
request id. `InvalidAppKey`, `IncompleteSignature`, `IllegalAccessToken` and other token/signature/app-key codes are
`auth_error`; `ApiCallLimit` and other limit codes `rate_limited`; permission codes `permission_denied`;
not-found codes `not_found`; parameter and `E0xxx` business codes `invalid_input`. `SYSTEM`/`ISP` failures are
retried on reads; on writes they, 5xx and network failures say the outcome is unknown and are never retried. A 2xx
body without `code` is an error (success cannot be confirmed). The app secret and token are redacted everywhere.

## Testing
```bash
npm test          # from the repo root
```
Signing (base string, byte-order sort, uppercase hex), XML payload escaping, every operation's signed request,
node-only writes, region selection, error envelopes and redaction, offset paging and `api_request` limits.
Live check: the example with an invalid app key gives
`auth_error: API error: The specified App Key is invalid (InvalidAppKey, request_id ...)`.

## License
Apache-2.0
