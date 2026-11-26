# paypal

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the
[PayPal REST API](https://developer.paypal.com/api/rest/): Orders v2 (create, get, capture, authorize), captures,
authorizations and refunds, Invoicing v2 (draft invoices), Payouts, and reporting (balances, transactions). It is
built with the declarative REST layer ([`definition.mjs`](definition.mjs)) plus small agent-safety wrappers in
[`lib/`](lib/).

**Live credentials move real money.** The plugin uses the sandbox unless `PAYPAL_ENV=live`.

## Features
- **Orders:** `create_order` (returns the buyer's approve link), `get_order`, `capture_order`, `authorize_order`
- **Payments:** `get_capture`, `refund_capture`, `get_refund`, `get_authorization`, `capture_authorization`,
  `void_authorization`
- **Invoices:** `list_invoices`, `get_invoice`, `create_invoice` (draft), `send_invoice`
- **Account:** `get_balances`, `list_transactions` (up to 31 days per call)
- **Payouts:** `create_payout`, `get_payout_batch`
- **`api_request`:** any other endpoint (agents: GET and allowlisted paths only)

Lists page by page number: pass `next_cursor` back as `cursor`. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A PayPal Business account and a REST app (sandbox apps are free)

## Installation
```bash
graphrt plugin install ./paypal
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `PAYPAL_CLIENT_ID` | yes | REST app client id |
| `PAYPAL_CLIENT_SECRET` | yes | REST app secret (OAuth2 client credentials; the token is cached in memory) |
| `PAYPAL_ENV` | no | `sandbox` (default, `api-m.sandbox.paypal.com`) or `live` (`api-m.paypal.com`) |
| `PAYPAL_TOOL_ALLOW_ORDERS` | no | `1` lets agent tools create orders, within the cap below |
| `PAYPAL_TOOL_MAX_AMOUNT` | for agent orders | Maximum total of an agent-created order (sum of `purchase_units[].amount.value`, major unit, e.g. `50` = $50). Unset or `0` refuses every one |
| `PAYPAL_TOOL_ALLOWED_CURRENCIES` | for agent orders | Comma-separated currencies agents may use, e.g. `USD`. Unset refuses every agent order |
| `PAYPAL_TOOL_ALLOW_INVOICES` | no | `1` lets agent tools create draft invoices (item totals within `PAYPAL_TOOL_MAX_AMOUNT`) |
| `PAYPAL_TOOL_ALLOWED_RETURN_HOSTS` | no | Comma-separated hosts agent orders may use in `return_url` / `cancel_url` (any https host when unset) |
| `PAYPAL_TOOL_API_EXTRA_PATHS` | no | More GET paths agents may reach with `api_request`, comma-separated, `*` = one segment |

**Getting credentials:** developer.paypal.com → Apps & Credentials → Create App (Sandbox or Live tab) → copy the
client id and secret. The app needs the features you use enabled (Invoicing, Payouts, Transaction Search for
`list_transactions` and balances). Payouts must be enabled on the live account by PayPal.

**Pricing:** API calls are free; PayPal charges its fees on received payments and on payouts.

## Quick Start
```bash
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... graphrt run paypal/example.yaml --plugins .
```
The example reads your balances and the five newest invoices.

## Usage
```yaml
- id: order
  type: paypal.create_order
  purchase_units: [{ reference_id: "{{#start.order_id#}}", amount: { currency_code: USD, value: "25.00" } }]
  return_url: https://shop.example/paypal/return
  cancel_url: https://shop.example/paypal/cancel
- id: capture             # after the buyer approved
  type: paypal.capture_order
  order_id: "{{#order.data.id#}}"
```

## Agent policy
- **Reads** are agent tools: orders, captures, authorizations, refunds, invoices, balances, transactions.
- **Orders** need `PAYPAL_TOOL_ALLOW_ORDERS=1` **and** `PAYPAL_TOOL_MAX_AMOUNT` **and**
  `PAYPAL_TOOL_ALLOWED_CURRENCIES`. Every purchase unit needs a positive `amount.value` in a listed currency, and
  their total must be within the cap. An order only moves money after the buyer approves it and a node captures it.
  `payment_source` (saved payment methods) is not accepted.
  Purchase units from agents are checked against an allowlist of keys at every depth: `reference_id`,
  `description`, `custom_id`, `invoice_id`, `soft_descriptor`, `amount` (`currency_code`, `value`, `breakdown`),
  `items` (`name`, `quantity`, `description`, `sku`, `category`, `unit_amount`, `tax`) and `shipping` (`type`,
  `name`, `address`). `payee` and `payment_instruction` (which would pay another merchant account or a platform fee)
  and any other key are refused; workflow nodes may set them. Money values must be decimal strings (`"10.50"`).
- **Draft invoices** need `PAYPAL_TOOL_ALLOW_INVOICES=1`; nothing is emailed until `send_invoice` (node only).
  Agent invoices need items (`name`, `quantity`, `description`, `unit_of_measure`, `unit_amount` only) whose total
  is within `PAYPAL_TOOL_MAX_AMOUNT` in listed currencies.
- **All calls:** currency codes are trimmed and uppercased, and `return_url` / `cancel_url` must be https.
- **Node only:** `capture_order`, `authorize_order`, `refund_capture`, `capture_authorization`, `void_authorization`,
  `send_invoice`, `create_payout`, `get_payout_batch` (recipients' details).
- `api_request` is GET-only for agents and limited to orders, payments, invoices, balances, transactions, catalog
  products and billing plans/subscriptions; vault (saved payment methods), webhooks, identity and payouts are
  unreachable.

## Errors
PayPal's first `details[].description` (or `message`) and `name` are shown. `AUTHENTICATION_FAILURE` and token
errors (`invalid_client`) are `auth_error`, `NOT_AUTHORIZED` / `PERMISSION_DENIED` `permission_denied` (feature not
enabled for the app), `RESOURCE_NOT_FOUND` `not_found`, `INVALID_REQUEST` / `UNPROCESSABLE_ENTITY` `invalid_input`,
`RATE_LIMIT_REACHED` `rate_limited`. Writes send `PayPal-Request-Id`, so a 5xx or network failure is retried with the
same id (PayPal returns the first result); draft invoices have no id and are never retried (check `list_invoices`).
Payouts are also deduplicated by `sender_batch_id`.

## Testing
```bash
npm test          # from the repo root
```
Contract suite for every operation, plus host selection (token and API), the order cap and currency allowlist,
error details and the `api_request` allowlist. Live check: the example with invalid credentials gives
`auth_error: OAuth token request failed (HTTP 401): invalid_client: Client Authentication failed`.

## License
Apache-2.0
