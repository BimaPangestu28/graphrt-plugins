# xendit

**Status:** beta · **ToS risk:** none. Official API; checked live only with an invalid key, and get_payout's api-version header is unverified. See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the [Xendit API](https://docs.xendit.co)
(Indonesia, Philippines and South-East Asia): invoices (hosted payment pages), payment requests (Payments API v3),
balance, transactions, refunds and payouts (v3). It is built with the declarative REST layer
([`definition.mjs`](definition.mjs)) plus small agent-safety wrappers in [`lib/`](lib/).

**A live key (`xnd_production_...`) moves real money.** Develop with a test-mode key (`xnd_development_...`).

## Features
- **Invoices:** `create_invoice` (returns `invoice_url`), `get_invoice`, `list_invoices`, `expire_invoice` (node only)
- **Payment requests (v3, `api-version: 2024-11-11`):** `create_payment_request` (node only), `get_payment_request`
- **Balance and ledger:** `get_balance`, `list_transactions`
- **Refunds:** `create_refund` (node only), `get_refund`
- **Payouts (v3, `api-version: 2025-09-01`):** `create_payout`, `get_payout` (both node only)
- **`api_request`:** any other endpoint (agents: GET and allowlisted paths only)

Lists page with the last item's id: pass `next_cursor` back as `cursor` (sent as `last_invoice` / `after_id`).

**Not verified against a live account:** `get_payout` sends `api-version: 2025-09-01` (the version documented for
creating v3 payouts; the get endpoint's own version is not documented), and list filters such as `statuses` are
sent as repeated keys (`statuses=PAID&statuses=SETTLED`), the form Xendit's SDKs produce. If Xendit rejects either,
use `api_request` from a node with the form it documents.
Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Xendit account (test mode is free)

## Installation
```bash
graphrt plugin install ./xendit
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `XENDIT_SECRET_KEY` | yes | Secret API key, sent as the Basic auth user with an empty password |
| `XENDIT_TOOL_ALLOW_INVOICES` | no | `1` lets agent tools create invoices, within the cap below |
| `XENDIT_TOOL_MAX_AMOUNT` | for agent invoices | Maximum `amount` per agent-created invoice, in the currency's major unit (e.g. `500000` = Rp500.000). Unset or `0` refuses every one |
| `XENDIT_TOOL_ALLOWED_CURRENCIES` | for agent invoices | Comma-separated currencies agents may use, e.g. `IDR`. Unset refuses every agent invoice |
| `XENDIT_TOOL_API_EXTRA_PATHS` | no | More GET paths agents may reach with `api_request`, comma-separated, `*` = one segment |

**Getting a key:** Xendit Dashboard → Settings → Developers → API Keys → Generate secret key. Give it only the
permissions you need: Money-in (Invoices, Payment Requests) read/write, Balance and Transactions read, Refunds and
Money-out (payouts) write only for node workflows that need them.

**Pricing:** API calls are free; Xendit charges per successful payment (depends on the channel) and per payout.

**Arguments:** `currency` is trimmed and uppercased on every call, and `success_redirect_url` /
`failure_redirect_url` must be https.

**Notifications:** invoice and payment callbacks go to the URLs configured in the dashboard; the plugin has no
per-call callback URL. Redirect URLs (`success_redirect_url`) only send the payer's browser back to you.

## Quick Start
```bash
XENDIT_SECRET_KEY=xnd_development_... graphrt run xendit/example.yaml --plugins .
```
The example reads the cash balance and the five newest invoices.

## Usage
```yaml
- id: invoice
  type: xendit.create_invoice
  external_id: "ORDER-{{#start.order_id#}}"
  amount: 250000
  description: Kopi 1kg
  payment_methods: [QRIS, BCA, OVO]
  invoice_duration: 86400
- id: link
  type: answer
  answer: "Pay here: {{#invoice.data.invoice_url#}}"
```

## Agent policy
- **Reads** are agent tools: invoices, payment requests, balance, transactions, refunds.
- **Invoices** need `XENDIT_TOOL_ALLOW_INVOICES=1` **and** `XENDIT_TOOL_MAX_AMOUNT` **and**
  `XENDIT_TOOL_ALLOWED_CURRENCIES` (the currency defaults to IDR). An invoice only charges a payer who pays it.
- **Node only:** `expire_invoice`, `create_payment_request` (it can charge a saved payment token at once),
  `create_refund`, `create_payout`, `get_payout` (it shows recipients' bank details).
- `api_request` is GET-only for agents and limited to invoices, balance, transactions, payment requests by id and
  refunds; payouts, payment tokens and customers are unreachable.

## Errors
Xendit's `message` and `error_code` are shown. `INVALID_API_KEY` (401) is `auth_error`, `REQUEST_FORBIDDEN_ERROR` /
`FEATURE_NOT_AVAILABLE` `permission_denied` (key permission or feature not enabled), `*_NOT_FOUND*` `not_found`,
`API_VALIDATION_ERROR` / `DUPLICATE_ERROR` `invalid_input`, `RATE_LIMIT_EXCEEDED` `rate_limited`.
Writes are never retried blindly: refunds and payouts send an `idempotency-key`, so a 5xx or network failure is
retried with the same key; invoices and payment requests have no key and are not retried (the error says how to check).

## Testing
```bash
npm test          # from the repo root
```
Contract suite for every operation, plus the amount cap, currency allowlist, idempotency keys, error codes and the
`api_request` allowlist. Live check: the example with an invalid key gives
`auth_error: API error 401: The API key provided is invalid. ... (INVALID_API_KEY)`.

## License
Apache-2.0
