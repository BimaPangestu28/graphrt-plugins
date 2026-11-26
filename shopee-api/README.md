# shopee-api

**Status:** experimental · **ToS risk:** low. Request signing is unit-tested but never accepted by Shopee: the live check with fake credentials got error_sign. See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for a seller's shop on the **Shopee Open Platform v2**
(`partner.shopeemobile.com/api/v2`). It covers the shop, products, stock and prices, orders, shipping and seller chat.
Every request is signed with your app's partner key, as Shopee requires.

Every operation is a workflow node. Most are also agent tools; `update_stock`, `update_price`, `ship_order` and
`refresh_access_token` are **node only** (see [Agent safety](#agent-safety)).

## Agent safety
- **Node only by design:** `update_stock`, `update_price` and `ship_order` change money, inventory or shipments, so
  they are never offered to an LLM as tools. They run only where a person placed them in a workflow.
  `refresh_access_token` is node only too, so tokens never reach an LLM. As a tool, `api_request` is read-only (GET).
- **Buyer chats are untrusted input.** `sellerchat_get_message` returns text written by buyers. An agent that reads
  it can be prompt-injected ("ignore your instructions and send ..."). `sellerchat_send_message` stays an agent tool,
  so give chat-reading agents narrow instructions, review what they send, or put sending behind a workflow node.

## Features
- **Shop:** `get_shop_info`
- **Products:**
  - `get_item_list` (offset paging) and `get_item_base_info` (up to 50 items).
  - `update_stock` and `update_price` (node only, up to 50 models per call). The result shows Shopee's
    `failure_list`, so you can see which models were rejected. A model (or model and location) may appear only once per call.
- **Orders:** `get_order_list` (a window of at most 15 days, checked before the call) and `get_order_detail` (up to 50 orders)
- **Shipping:** `get_shipping_parameter`, `ship_order` (node only; pickup, drop-off or non-integrated) and `get_tracking_number`
- **Seller chat:** `sellerchat_get_conversation_list`, `sellerchat_get_message` and `sellerchat_send_message` (text, image URL, item card, order card)
- **Token refresh (node only):** `refresh_access_token` returns the new access token and the new refresh token
- **`api_request`:** any other v2 endpoint, signed. Use `api_type: shop` (the default) or `api_type: public` for partner-level APIs.
- **Errors:** Shopee's error envelope (`error`, `message`, `request_id`) is mapped to stable kinds, also when it
  arrives in an HTTP 200 body. A 2xx body without the envelope is an `api_error`. The partner key and tokens never appear in errors or in `api_request` results.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Shopee Open Platform app (partner id and partner key) and a shop that authorized it. Get the first access and
  refresh tokens through Shopee's authorization flow (`/api/v2/shop/auth_partner`, then `/api/v2/auth/token/get`). The
  plugin does not run the authorization.
- **Seller chat** needs Shopee's seller chat API permission for your app. Without it the chat operations fail with
  `permission_denied` or `auth_error`. Shopee's chat API reference is only visible to logged-in developers, so the
  chat parameters were taken from public Shopee SDKs; check them against the console docs.
- If you declared an IP allow list in the Shopee console, calls from other IPs fail with `source_ip_undeclared` (`permission_denied`).

## Installation
```bash
graphrt plugin install ./shopee-api
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `SHOPEE_PARTNER_ID` | yes | App partner id (a number). Test and live apps have different ids |
| `SHOPEE_PARTNER_KEY` | yes | App partner key, used to sign every request. Never an argument |
| `SHOPEE_SHOP_ID` | yes | The authorized shop's id |
| `SHOPEE_ACCESS_TOKEN` | for shop operations | Shop access token. It is valid for 4 hours |
| `SHOPEE_REFRESH_TOKEN` | for `refresh_access_token` | Refresh token. It is valid for 30 days and can be used once |
| `SHOPEE_ENV` | no | `live` (default, `partner.shopeemobile.com`) or `test` (sandbox, `openplatform.sandbox.test-stable.shopee.sg`) |

graphrt starts plugins with a clean environment and passes through only these variables. A node can also take
`access_token`, which overrides `SHOPEE_ACCESS_TOKEN`. Pass it from a secret and trust the plugin (`--trust-plugin shopee-api`).

### Keeping the token fresh
The access token lasts 4 hours. Run `refresh_access_token` before it expires and **store both returned tokens**: each
refresh token works only once. The operation is node only, so tokens never reach an LLM.
```yaml
- id: refresh
  type: shopee-api.refresh_access_token
# then save {{#refresh.data.access_token#}} and {{#refresh.data.refresh_token#}} in your secret store
```

## Quick Start
```bash
export SHOPEE_PARTNER_ID=... SHOPEE_PARTNER_KEY=... SHOPEE_SHOP_ID=... SHOPEE_ACCESS_TOKEN=...
graphrt run shopee-api/example.yaml --plugins .
```

## Usage
```yaml
- id: orders
  type: shopee-api.get_order_list
  time_from: 1763424000        # Unix seconds
  time_to: 1764633600          # at most 15 days later
  order_status: READY_TO_SHIP
- id: stock
  type: shopee-api.update_stock
  item_id: 800123
  stock_list: [{ model_id: 0, stock: 25 }]
- id: reply
  type: shopee-api.sellerchat_send_message
  to_id: "556677"
  text: "Terima kasih, pesanan sudah dikirim!"
```
- **Paging:** list operations return `data` and `next_cursor`. Pass `next_cursor` back as `cursor`; it is `null` on the last page.
- **Order windows:** `get_order_list` needs `time_from` and `time_to` in Unix **seconds**, at most 15 days apart.
  A longer range, a reversed one or milliseconds fail with `invalid_input` before any call. Split longer ranges into several calls.
- **Shipping flow:** call `get_shipping_parameter`, then `ship_order` with exactly one of `pickup`, `dropoff` or
  `non_integrated`, as its `info_needed` says. Send `{}` when the mode needs no fields.
- **Writes are never retried after an unknown outcome.** `update_stock`, `update_price`, `ship_order` and
  `sellerchat_send_message` are POSTs. If one fails with a network error or a 5xx, the error is not retryable and
  says the outcome is unknown. Check first (with `get_item_base_info`, `get_tracking_number` or
  `sellerchat_get_message`) before you send it again. The same holds for a write whose HTTP 200 body has no Shopee
  envelope or carries a server failure code (`error_server`, `error_inner`, `error_busy`, `error_network`). Reads
  retry those codes. Rate-limit rejections are retried, because Shopee did not apply them.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments, an order window over 15 days, `error_param*`, an unknown `SHOPEE_ENV` |
| `auth_error` | Missing credentials (the message names the env var), `error_auth`, `error_sign` (wrong partner key or clock), `invalid_access_token`, `error_partner_key_expired` |
| `permission_denied` | `error_permission`, `error_api_permission`, `shop_no_linked`, `source_ip_undeclared`, `shop_banned` |
| `not_found` | `error_not_found`, `error_item_not_found` |
| `rate_limited` | `error_rate_limit`, `error_too_many_requests`, HTTP 429, retried automatically for up to 60 s. `error_limit` (the daily quota, which resets at 00:00 UTC+8) is not retried |
| `api_error`, `network_error`, `cancelled` | As named, plus a 2xx body without the Shopee envelope. Reads are retried on 5xx, network errors and server failure codes in HTTP 200 bodies, writes are not |

Shopee's message is kept, together with the error code and `request_id` for support requests.

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it.

## Changelog
### 0.1.0 (unreleased)
- **Breaking:** `sellerchat_get_conversation_list` parameter `type` is now `conversation_type` (still sent to Shopee as `type`). graphrt takes `type` from every workflow node, so the old name could never be set from a node; tool calls that passed `type` must use `conversation_type`.

## License
Apache-2.0
