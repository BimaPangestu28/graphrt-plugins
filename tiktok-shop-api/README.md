# tiktok-shop-api

**Status:** experimental · **ToS risk:** low. Request signing is unit-tested but never accepted by TikTok Shop: the live check used an invalid app key. See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for a seller's shop on **TikTok Shop**, through the
TikTok Shop Partner API (`open-api.tiktokglobalshop.com`, versioned endpoints from 202309 on). It covers products,
inventory and prices, orders, shipping, returns and buyer messages. Every request is signed with your app secret,
as TikTok Shop requires.

Every operation is a workflow node. Most are also agent tools; `update_inventory`, `update_price`, `ship_package`
and `refresh_access_token` are **node only** (see [Agent safety](#agent-safety)).

## Agent safety
- **Node only by design:** `update_inventory`, `update_price` and `ship_package` change money, inventory or
  shipments, so they are never offered to an LLM as tools. They run only where a person placed them in a workflow.
  `refresh_access_token` is node only too, so tokens never reach an LLM. As a tool, `api_request` is read-only (GET).
- **Buyer messages are untrusted input.** `get_conversation_messages` returns text written by buyers. An agent that
  reads it can be prompt-injected ("ignore your instructions and send ..."). `send_message` stays an agent tool, so
  give chat-reading agents narrow instructions, review what they send, or put sending behind a workflow node.

## Features
- **Shops:** `get_authorized_shops`, which returns each shop's `cipher`
- **Products:**
  - `search_products` and `get_product`.
  - `update_inventory` (node only; per SKU and warehouse, each SKU/warehouse pair once) and `update_price` (node only;
    per SKU, `currency` as an uppercase code such as `IDR`; IDR, JPY, KRW and VND prices must be whole numbers).
- **Orders:** `search_orders` and `get_order_detail` (up to 50 orders)
- **Fulfilment:** `ship_package` (node only; TikTok Shipping pickup or drop-off, or seller shipping) and
  `get_package_shipping_document` (a label or packing slip URL that is valid for 24 hours; the plugin does not download it)
- **Returns:** `search_returns`
- **Customer service:** `get_conversations`, `get_conversation_messages` and `send_message` (text or cards)
- **Token refresh (node only):** `refresh_access_token` calls `auth.tiktok-shops.com` and returns the new tokens
- **`api_request`:** any other Open API endpoint, signed. Set `include_shop_cipher: false` for app-level endpoints.
  Paths may use only letters, digits, `_`, `-` and `~` per segment (no `%` encodings or dots), so the signed path is
  exactly the path that is sent.
- **Errors:** TikTok Shop's envelope (`code`, `message`, `request_id`) is mapped to stable kinds, also when it
  arrives in an HTTP 200 body. A 2xx body without `code` is an `api_error`. The app secret and tokens never appear in errors or in `api_request` results.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A TikTok Shop app in Partner Center (app key and app secret) with the scopes for the operations you use: shop
  authorization, product, order, fulfillment, return and **customer service** (needed for the message operations).
  Missing scopes fail with `permission_denied` (code 105005).
- A shop that authorized the app. Get the first access and refresh tokens through the authorization flow
  (`https://auth.tiktok-shops.com/api/v2/token/get`). The plugin does not run it.
- Call `get_authorized_shops` once and set `TIKTOK_SHOP_CIPHER` to your shop's `cipher`.

## Installation
```bash
graphrt plugin install ./tiktok-shop-api
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `TIKTOK_SHOP_APP_KEY` | yes | App key from Partner Center |
| `TIKTOK_SHOP_APP_SECRET` | yes | App secret, used to sign every request. Never an argument |
| `TIKTOK_SHOP_ACCESS_TOKEN` | for API operations | Seller access token, sent in the `x-tts-access-token` header (valid about 7 days) |
| `TIKTOK_SHOP_CIPHER` | for shop operations | The shop's `cipher` from `get_authorized_shops` |
| `TIKTOK_SHOP_REFRESH_TOKEN` | for `refresh_access_token` | Refresh token |

graphrt starts plugins with a clean environment and passes through only these variables. A node can also take
`access_token`, which overrides `TIKTOK_SHOP_ACCESS_TOKEN`. Pass it from a secret and trust the plugin
(`--trust-plugin tiktok-shop-api`).

### Keeping the token fresh
Run `refresh_access_token` before the access token expires, and store the returned `access_token` and
`refresh_token`. The operation is node only, so tokens never reach an LLM. It is not retried automatically: a
refresh may rotate the refresh token, so a network or server failure is not retryable and says the outcome is
unknown. Check whether the old refresh token still works before you try again.

## Quick Start
```bash
export TIKTOK_SHOP_APP_KEY=... TIKTOK_SHOP_APP_SECRET=... TIKTOK_SHOP_ACCESS_TOKEN=...
graphrt run tiktok-shop-api/example.yaml --plugins .
```

## Usage
```yaml
- id: to_ship
  type: tiktok-shop-api.search_orders
  order_status: AWAITING_SHIPMENT
  create_time_ge: 1763424000   # Unix seconds
- id: stock
  type: tiktok-shop-api.update_inventory
  product_id: "1729592969712207008"
  skus: [{ sku_id: "1729592969712207013", quantity: 25 }]
- id: reply
  type: tiktok-shop-api.send_message
  conversation_id: "{{#start.conversation_id#}}"
  text: "Terima kasih! Paket kakak sudah kami kirim."
```
- **Ids are strings.** TikTok Shop ids are 64-bit numbers, larger than JavaScript can hold exactly, so pass them quoted.
- **Paging:** list operations return `data` and `next_cursor`. Pass `next_cursor` back as `cursor`; it is `null` on
  the last page, and also when TikTok Shop returns the same page token again. Page sizes: products and orders up to 100, returns 10–50, conversations up to 20, messages up to 10.
- **Times** are Unix **seconds**. Milliseconds and reversed ranges fail with `invalid_input` before any call.
- **Writes are never retried after an unknown outcome.** `update_inventory`, `update_price`, `ship_package` and
  `send_message` are POSTs. If one fails with a network error or a 5xx, the error is not retryable and says the
  outcome is unknown. Check first (with `get_product`, `get_order_detail` or `get_conversation_messages`) before you
  send it again. The same holds for a write whose HTTP 200 body has no `code`. Rate-limit rejections are retried,
  because TikTok Shop did not apply them. `search_orders`, `search_products` and `search_returns` are POSTs that
  only read, so they are retried like reads.
- **Messages:** you can only message buyers in conversations where `can_send_message` is true. Text is limited to 2,000 characters.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments, a missing `TIKTOK_SHOP_CIPHER`, codes 106013 (missing shop_cipher), 36009009/36009010 (path/method), 36009004 with an identifier or version message |
| `auth_error` | Missing credentials (the message names the env var), 105002 (expired token), 106001 (bad sign), 36009004 with a credential, signature, app_key or timestamp message, 101000, other 105xxx codes |
| `permission_denied` | 105005 (missing scope), 36009033 (IP not allowed), 45102007 |
| `not_found` | 45101003, 12052032, 12052260 |
| `rate_limited` | 36009002 or HTTP 429, retried automatically for up to 60 s. 45101004 (the daily message quota) is not retried |
| `api_error`, `network_error`, `cancelled` | As named, plus a 2xx body without `code`. Reads (including the POST searches) are retried on 5xx and network errors, writes and token refresh are not |

TikTok Shop's message is kept, together with the code and `request_id` for support requests.

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it.

## Changelog
### 0.1.0 (unreleased)
- **Breaking:** `send_message` parameter `type` is now `message_type` (still sent to TikTok Shop as `type`). graphrt takes `type` from every workflow node, so the old name was silently dropped on nodes (every node message was TEXT); tool calls that passed `type` must use `message_type`.

## License
Apache-2.0
