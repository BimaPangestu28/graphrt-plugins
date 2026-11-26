# woocommerce

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the
[WooCommerce REST API v3](https://woocommerce.github.io/woocommerce-rest-api-docs/) of one store: products and
variations, orders, customers and refunds. It is built with the declarative REST layer
([`definition.mjs`](definition.mjs)) plus small agent-safety wrappers in [`lib/`](lib/).

## Features
- **Products:** `list_products`, `get_product`, `list_product_variations`, `update_product`
- **Orders:** `list_orders`, `get_order`, `update_order_status`, `list_order_refunds`, `create_refund` (node only)
- **Customers:** `list_customers`, `get_customer`
- **`api_request`:** any other endpoint under `/wp-json/wc/v3` (agents: GET and allowlisted paths only), e.g.
  `/reports/sales` or `/coupons`

Lists page by page number: pass `next_cursor` back as `cursor` (`limit` is `per_page`, up to 100).
Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A WooCommerce store served over https, with pretty permalinks (so `/wp-json/` works)

## Installation
```bash
graphrt plugin install ./woocommerce
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `WOOCOMMERCE_SITE_URL` | yes | The store's https URL, e.g. `https://shop.example.com` (a WordPress subdirectory like `https://example.com/store` works). http is refused |
| `WOOCOMMERCE_CONSUMER_KEY` | yes | REST API consumer key (`ck_...`) |
| `WOOCOMMERCE_CONSUMER_SECRET` | yes | REST API consumer secret (`cs_...`), sent with the key as Basic auth |
| `WOOCOMMERCE_TOOL_ALLOW_PRODUCTS` | no | `1` lets agent tools update products (not prices or stock) |
| `WOOCOMMERCE_TOOL_ALLOW_ORDER_STATUS` | no | `1` lets agent tools put an order on hold (`on-hold` only) |
| `WOOCOMMERCE_TOOL_API_EXTRA_PATHS` | no | More GET paths agents may reach with `api_request`, comma-separated, `*` = one segment |

**Getting keys:** WordPress admin → WooCommerce → Settings → Advanced → REST API → Add key. Choose a user with
the shop manager role and **Read** permission for read-only workflows, **Read/Write** only when nodes or opted-in
tools write. Some hosts strip the `Authorization` header; the plugin never falls back to keys in the query string,
so fix the server (e.g. `SetEnvIf Authorization` on Apache) if every call fails with `auth_error`.

**Pricing:** the REST API is part of WooCommerce (free). Refunds through a gateway follow that gateway's fees.

## Quick Start
```bash
WOOCOMMERCE_SITE_URL=https://shop.example.com WOOCOMMERCE_CONSUMER_KEY=ck_... WOOCOMMERCE_CONSUMER_SECRET=cs_... \
  graphrt run woocommerce/example.yaml --plugins .
```
The example lists the five newest processing orders and five in-stock products.

## Usage
```yaml
- id: complete
  type: woocommerce.update_order_status
  order_id: "{{#start.order_id#}}"
  status: completed
- id: refund
  type: woocommerce.create_refund
  order_id: "{{#start.order_id#}}"
  amount: "25.00"
  reason: Damaged in transit
```

## Agent policy
- **Reads** are agent tools (orders and customers contain personal data).
- **Products** (`WOOCOMMERCE_TOOL_ALLOW_PRODUCTS=1`): `update_product` for name, descriptions, status, SKU,
  categories and tags. Setting `status` to `draft`, `pending` or `private` takes a product off the shop. `regular_price`, `sale_price`, `manage_stock`, `stock_quantity` and `stock_status` are refused
  for agents (the same ruling as the Shopee and Lazada plugins); workflow nodes may set them.
- **Order status** (`WOOCOMMERCE_TOOL_ALLOW_ORDER_STATUS=1`): agents may only set `on-hold`. `processing` and
  `completed` are node only because they release goods even for an unpaid order, and `pending`, `cancelled`,
  `refunded`, `failed` and `draft` are node only too. WooCommerce may email the customer on status changes.
- **Node only:** `create_refund` (by default through the payment gateway).
- `api_request` is GET-only for agents and limited to products (and categories, tags, attributes, reviews,
  variations), orders (notes, refunds), customers, coupons and reports. Coupon codes are readable by agents (an
  agent could share a private discount code). Settings, payment gateways (their settings hold gateway API keys),
  system status and webhooks are unreachable for agents. For agents the `path` may not contain a query string and
  `query` keys must be read filters (`per_page`, `page`, `search`, `status`, `orderby`, `order`, `after`, `before`,
  `include`, `exclude`, `sku`, `category`, `customer`, `product`, `parent`, `offset`, `context`): WordPress's
  `_method` and `rest_route` parameters would otherwise turn a GET into a refund, price change or delete.

## Errors
WooCommerce's `message` and `code` are shown. 401 is `auth_error` (wrong key or secret), except
`woocommerce_rest_cannot_view` / `_cannot_edit` / `_cannot_create` (the key lacks read or write permission), which
are `permission_denied`; `*_invalid_id` and `rest_no_route` are `not_found`; `rest_invalid_param` is `invalid_input`.
Product and order-status updates are PUTs of the same fields, so they are retried after 5xx and network failures;
refunds are never retried blindly (check `list_order_refunds`).

## Testing
```bash
npm test          # from the repo root
```
Contract suite for every operation, plus the site URL check, Basic auth, the price/stock and order-status limits for
agents, error codes and the `api_request` allowlist. Live check: the example against a WooCommerce site with invalid
keys gives `auth_error: API error 401: ... Unknown username ... (invalid_username)`.

## License
Apache-2.0
