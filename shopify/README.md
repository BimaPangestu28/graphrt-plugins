# shopify

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the
[Shopify Admin GraphQL API](https://shopify.dev/docs/api/admin-graphql) (version `2026-10`): shop, products,
orders, customers, locations and inventory levels, product create/update, and inventory adjustments, order edits,
refunds and cancellations as workflow nodes. Every operation sends a constant GraphQL document with typed
variables; there is no free-form GraphQL and no `api_request`. Built with the declarative REST layer
([`definition.mjs`](definition.mjs)) plus [`lib/graphql-mutations.mjs`](lib/graphql-mutations.mjs).

## Features
- **Shop:** `get_shop`
- **Products:** `list_products` (Shopify search syntax), `get_product`, `create_product`, `update_product`
- **Orders:** `list_orders`, `get_order`, `update_order` (note, tags, email), `create_refund`, `cancel_order`
- **Customers:** `list_customers`, `get_customer`
- **Inventory:** `list_locations`, `list_inventory_levels`, `adjust_inventory`

Lists follow GraphQL cursors: pass `next_cursor` back as `cursor` (`limit` is `first`, up to 250).
Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Shopify store and an Admin API access token

## Installation
```bash
graphrt plugin install ./shopify
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `SHOPIFY_SHOP_DOMAIN` | yes | Your store's `<name>.myshopify.com` domain (custom domains are refused) |
| `SHOPIFY_ACCESS_TOKEN` | yes | Admin API access token (`shpat_...`), sent as `X-Shopify-Access-Token` |
| `SHOPIFY_TOOL_ALLOW_PRODUCTS` | no | `1` lets agent tools create and update products |

**Getting a token:** create an app in the Shopify Dev Dashboard (or a custom app in the store admin: Settings →
Apps and sales channels → Develop apps), install it on the store and copy the Admin API access token. Scopes:
`read_products`, `read_orders`, `read_customers`, `read_inventory`, `read_locations` for reads; `write_products`
for product writes; `write_inventory` for `adjust_inventory`; `write_orders` for order edits, refunds and
cancellations. Orders older than 60 days need `read_all_orders`; customer data needs Shopify's protected customer
data approval.

**Pricing:** the Admin API is free; requests are rate limited by query cost (a leaky bucket per app and store).
Throttled requests (`THROTTLED`) are `rate_limited` and reads are retried.

## Quick Start
```bash
SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com SHOPIFY_ACCESS_TOKEN=shpat_... graphrt run shopify/example.yaml --plugins .
```
The example reads the shop and its five newest active products.

## Usage
```yaml
- id: unfulfilled
  type: shopify.list_orders
  query: "fulfillment_status:unfulfilled financial_status:paid"
  limit: 20
- id: restock
  type: shopify.adjust_inventory
  reason: received
  changes: [{ delta: 10, inventoryItemId: "gid://shopify/InventoryItem/1", locationId: "gid://shopify/Location/1", changeFromQuantity: 0 }]
```

## Agent policy
- **Reads** are agent tools (orders and customers contain personal data: names, emails, addresses).
- **Opt-in writes** (`SHOPIFY_TOOL_ALLOW_PRODUCTS=1`): `create_product` (DRAFT unless `status` is given),
  `update_product`. Setting `status: ACTIVE` publishes the product; `ARCHIVED` or `DRAFT` takes it off every sales channel.
- **Node only:** `adjust_inventory`, `update_order`, `create_refund` (money back to the customer), `cancel_order`
  (can refund and notify the customer).
- No `api_request`: only the constant documents above reach the API.

## Errors
GraphQL errors arrive with HTTP 200 and are errors here: `THROTTLED` is `rate_limited`, `ACCESS_DENIED`
`permission_denied` (missing scope). A bad token is `auth_error` (401 "Invalid API key or access token"), an unknown
store `not_found`. Mutation `userErrors` (and `orderCancelUserErrors`) become `invalid_input` errors that say nothing
was changed. Writes are never retried blindly; `adjust_inventory` and `create_refund` send an `@idempotent` key (a
fresh UUID, or your `idempotency_key`). The key is returned as `data.idempotency_key` and named in every error: after an unknown outcome, retry with that key. Every `adjust_inventory` change needs `changeFromQuantity` (null skips the check) and, for states other than `available`, a `ledgerDocumentUri`.

## Testing
```bash
npm test          # from the repo root
```
Contract suite for every operation, plus the shop domain check, idempotency keys, userErrors and error mapping.
Live check: the example with an invalid token gives
`auth_error: API error 401: [API] Invalid API key or access token (unrecognized login or wrong password)`.

## License
Apache-2.0
