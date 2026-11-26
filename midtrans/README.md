# midtrans

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for [Midtrans](https://docs.midtrans.com), the
Indonesian payment gateway: create Snap payment pages (a token and a `redirect_url` to send to the payer) and read
transaction status through the Core API, plus cancel, expire, refund, approve/deny and capture as workflow nodes.
It is built with the declarative REST layer ([`definition.mjs`](definition.mjs)) plus small wrappers in
[`lib/`](lib/).

**Production keys move real money.** The plugin uses the sandbox unless `MIDTRANS_ENV=production`.

## Features
- **Snap:** `create_snap_transaction` (order id, IDR amount, items, customer, payment methods, expiry)
- **Status:** `get_transaction_status`, `get_b2b_transaction_status`
- **Node only:** `cancel_transaction`, `expire_transaction`, `refund_transaction`, `direct_refund_transaction`,
  `approve_transaction`, `deny_transaction` (fraud challenge), `capture_transaction` (card pre-auth)
- **`api_request`:** any other Core API endpoint on `api(.sandbox).midtrans.com` (agents: GET status paths only)

Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Midtrans merchant account (the sandbox is free)

## Installation
```bash
graphrt plugin install ./midtrans
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `MIDTRANS_SERVER_KEY` | yes | Server key (`SB-Mid-server-...` in the sandbox), sent as the Basic auth user with an empty password |
| `MIDTRANS_ENV` | no | `sandbox` (default: `app.sandbox.midtrans.com`, `api.sandbox.midtrans.com`) or `production` (`app.midtrans.com`, `api.midtrans.com`) |
| `MIDTRANS_TOOL_ALLOW_PAYMENTS` | no | `1` lets agent tools create Snap transactions, within the cap below |
| `MIDTRANS_TOOL_MAX_AMOUNT` | for agent Snap transactions | Maximum `gross_amount` (IDR) per agent-created transaction. Unset or `0` refuses every one |
| `MIDTRANS_TOOL_API_EXTRA_PATHS` | no | More GET paths agents may reach with `api_request`, comma-separated, `*` = one segment |

**Getting a key:** Midtrans Dashboard → Settings → Access Keys (switch the dashboard to Sandbox for sandbox keys).
Sandbox and production keys only work on their own hosts; a mismatch gives `auth_error`, with a hint when the key prefix (`SB-` for sandbox) does not fit `MIDTRANS_ENV`.

**Pricing:** API calls are free; Midtrans charges a fee per successful payment (MDR, depends on the method).

**Notifications:** payment notifications go to the URL configured in the dashboard. The plugin never sends
`X-Override-Notification` / `X-Append-Notification`, and Snap `callbacks` are not exposed, so neither an agent nor a
node can redirect notifications or payers to another host.

## Quick Start
```bash
MIDTRANS_SERVER_KEY=SB-Mid-server-... graphrt run midtrans/example.yaml --plugins .
```
The example reads the status of order `ORDER-1001` (an unknown order gives `not_found`).

## Usage
```yaml
- id: pay
  type: midtrans.create_snap_transaction
  order_id: "INV-{{#start.invoice_id#}}"
  gross_amount: 150000
  item_details: [{ id: "sku-1", name: "Kopi 1kg", price: 150000, quantity: 1 }]
  customer_details: { first_name: "Ana", email: "ana@example.com" }
  expiry_duration: 1
  expiry_unit: day
- id: link
  type: answer
  answer: "Pay here: {{#pay.data.redirect_url#}}"
```

## Agent policy
- **Reads** (`get_transaction_status`, `get_b2b_transaction_status`) are agent tools.
- **Snap transactions** need `MIDTRANS_TOOL_ALLOW_PAYMENTS=1` **and** `MIDTRANS_TOOL_MAX_AMOUNT`: an agent call over
  the cap is refused before anything is sent. A Snap page only charges a payer who opens and pays it.
- **Node only:** cancel, expire, refund, direct refund, approve, deny and capture.
- `api_request` is GET-only for agents and limited to `/v2/{id}/status`, `/v2/{id}/status/b2b` and
  `/v1/subscriptions/{id}` (more with `MIDTRANS_TOOL_API_EXTRA_PATHS`).

## Errors
Core API answers some failures with HTTP 200 and a body `status_code`; the plugin turns them into errors:
`401` `auth_error`, `404` `not_found` ("Transaction doesn't exist."), `406` (duplicate refund key), `412` (status
cannot be changed), `414` (invalid refund amount) `invalid_input`, `402`/`410` `permission_denied` (payment type
not active, merchant inactive), `429` `rate_limited`. `407` (expired) is a normal answer of the status read and of
`expire_transaction`. Snap errors show `error_messages` (e.g. "transaction_details.order_id has already been taken").

Writes are never retried blindly. Core API writes carry an `Idempotency-Key`, so a 5xx or network failure is
retried with the same key; refunds can also be retried safely with the same `refund_key` (7 days). Snap creation is
not retried: Midtrans refuses a second transaction with the same `order_id`, so check `get_transaction_status`
and use a new `order_id` if the first one never completed.

## Testing
```bash
npm test          # from the repo root
```
Contract suite for every operation, plus host selection, Basic auth, the amount cap, body `status_code` errors and
the `api_request` allowlist. Live check: the example with an invalid key gives `auth_error: API error 401: Unauthorized`.

## License
Apache-2.0
