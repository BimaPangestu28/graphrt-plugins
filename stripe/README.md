# stripe

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the [Stripe API](https://docs.stripe.com/api):
customers, PaymentIntents, payment links, invoices, products and prices, charges, balance, refunds and
subscriptions. Every request is pinned to `Stripe-Version: 2026-10-28.endive`, and every create sends a fresh
`Idempotency-Key`. It is built with the declarative REST layer ([`definition.mjs`](definition.mjs)) plus three
small agent-safety wrappers in [`lib/`](lib/).

**This plugin moves real money with a live key.** Develop with a test-mode key (`sk_test_...`), and read
[Agent policy](#agent-policy) before giving any operation to an LLM.

## Features
- **Customers:** `list_customers`, `search_customers` (Stripe search syntax), `get_customer`, `create_customer`,
  `update_customer`
- **PaymentIntents:** `list_payment_intents`, `get_payment_intent`, `create_payment_intent` (unconfirmed),
  `confirm_payment_intent`, `capture_payment_intent`, `cancel_payment_intent` (the last three node only)
- **Payment links:** `list_payment_links`, `create_payment_link` (buy.stripe.com link for existing prices)
- **Invoices:** `list_invoices`, `get_invoice`, `create_invoice` (always a draft: `auto_advance=false`),
  `add_invoice_item`, `finalize_invoice`, `send_invoice`, `pay_invoice` (the last four node only)
- **Catalog:** `list_products`, `get_product`, `create_product`, `list_prices`, `create_price`
- **Money in and out:** `list_charges`, `get_charge`, `get_balance`, `list_balance_transactions`, `list_refunds`,
  `create_refund` (node only)
- **Subscriptions:** `list_subscriptions`, `get_subscription`, `cancel_subscription` (node only)
- **`api_request`:** any other endpoint (GET only and allowlisted paths for agents), e.g. `/v1/disputes`

Lists use Stripe's cursor: pass `next_cursor` back as `cursor` (sent as `starting_after`, or `page` for
`search_customers`). Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Stripe account (test mode is free)

## Installation
```bash
graphrt plugin install ./stripe
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `STRIPE_SECRET_KEY` | yes | Secret key (`sk_test_...` / `sk_live_...`) or, better, a restricted key (`rk_...`), sent as Basic auth |
| `STRIPE_TOOL_ALLOW_WRITE` | no | `1` lets agent tools create/update customers, products, prices (capped) and draft invoices |
| `STRIPE_TOOL_ALLOW_PAYMENT_LINKS` | no | `1` lets agent tools create payment links |
| `STRIPE_TOOL_ALLOW_PAYMENT_INTENTS` | no | `1` lets agent tools create (unconfirmed) PaymentIntents, within the cap below |
| `STRIPE_TOOL_MAX_AMOUNT` | for agent PaymentIntents and prices | Maximum `amount` of an agent-created PaymentIntent and `unit_amount` of an agent-created price, in Stripe's minor units (see below). Unset or `0` refuses both |
| `STRIPE_TOOL_ALLOWED_CURRENCIES` | for agent PaymentIntents and prices | Comma-separated currencies agents may use, e.g. `usd,eur`. Unset refuses both |

**One cap, minor units.** `STRIPE_TOOL_MAX_AMOUNT` is a single number compared with Stripe's `amount` as sent, in
each currency's minor unit, for every allowed currency. `5000` is $50.00 or €50.00, but ¥5000 (JPY and KRW are
zero-decimal) and 5.000 KWD/BHD/JOD/OMR/TND (three-decimal). Stripe treats IDR as two-decimal, so `5000` is Rp50.
List only currencies whose minor units are worth about the same, or run separate plugin instances. `currency` is
trimmed and lowercased before the cap and before it is sent.
| `STRIPE_TOOL_API_EXTRA_PATHS` | no | More GET paths agents may reach with `api_request`, comma-separated, `*` = one segment |

**Getting a key:** Dashboard → Developers → API keys. Prefer a
[restricted key](https://docs.stripe.com/keys#limit-access) with only the resources you use (Customers, PaymentIntents,
Payment Links, Invoices, Products, Prices, Charges, Balance, Refunds, Subscriptions: read, plus write where needed).
A restricted key without write access is the strongest guard for agent-only setups.

**Pricing:** API calls are free; Stripe charges its processing fees on successful payments (and Billing/Invoicing
fees on paid invoices). Nothing here bills by itself until a customer pays or a node confirms/charges.

**Rate limits:** about 100 read and 100 write requests per second in live mode (25 in test mode); 429 is
`rate_limited` and reads are retried.

## Quick Start
```bash
STRIPE_SECRET_KEY=sk_test_... graphrt run stripe/example.yaml --plugins .
```
The example reads the balance and the three newest customers.

## Usage
```yaml
- id: intent
  type: stripe.create_payment_intent
  amount: 15000            # $150.00
  currency: usd
  customer: "{{#start.customer_id#}}"
  metadata: { order_id: "{{#start.order_id#}}" }
- id: refund
  type: stripe.create_refund
  payment_intent: "{{#intent.data.id#}}"
  amount: 5000
```

## Agent policy
- **Reads** are agent tools. PaymentIntent results never include `client_secret` for tools (removed at any depth,
  also from `api_request`); nodes get the full object.
- **Opt-in writes** (`STRIPE_TOOL_ALLOW_WRITE=1`): `create_customer`, `update_customer`, `create_product`,
  `create_price` (within `STRIPE_TOOL_MAX_AMOUNT` and `STRIPE_TOOL_ALLOWED_CURRENCIES`), `create_invoice`.
  Invoices stay drafts: adding items, finalizing, sending and charging them is node only (a subscription renewal
  draft with `auto_advance` on would charge an added item automatically). `update_customer` can change the
  customer's email, so receipts and invoice emails go to the new address.
- **Payment links** (`STRIPE_TOOL_ALLOW_PAYMENT_LINKS=1`): `create_payment_link`. A link only charges a customer who
  opens and pays it. Agents may only list existing prices as `{price, quantity}` with a quantity from 1 to 100;
  `price_data`, `adjustable_quantity` and other keys are refused (no redirect URLs, transfers or application fees).
- **PaymentIntents** (`STRIPE_TOOL_ALLOW_PAYMENT_INTENTS=1` **and** `STRIPE_TOOL_MAX_AMOUNT` **and**
  `STRIPE_TOOL_ALLOWED_CURRENCIES`): `create_payment_intent` creates an unconfirmed intent (no `confirm`,
  `payment_method`, `off_session`, `receipt_email`, transfers or fees are accepted). Amounts over the cap, or in a
  currency that is not listed, are refused before anything is sent. One cap applies to every listed currency, so
  list currencies of similar value.
- **Node only:** `add_invoice_item`, `confirm_payment_intent`, `capture_payment_intent`, `cancel_payment_intent`, `finalize_invoice`,
  `send_invoice`, `pay_invoice`, `create_refund`, `cancel_subscription`.
- `api_request` is GET-only for agents and limited to an allowlist (customers, charges, balance, balance
  transactions, invoices, invoice items, products, prices, subscriptions, refunds, disputes, payouts, payment links,
  coupons, promotion codes). PaymentIntents, SetupIntents, Checkout Sessions, events (they embed client secrets),
  Issuing (card numbers), Apps secrets and webhook endpoints are unreachable for agents.

## Errors
Stripe's `error.message` and `error.code` are shown, e.g. `API error 400: No such customer: 'cus_x' (resource_missing)`.
401 is `auth_error`, 403 `permission_denied` (restricted key without the permission), 404 / `resource_missing`
`not_found`, 400 `invalid_input`, 402 (card declined) `api_error` with the decline message, 429 `rate_limited`.
Writes are never retried blindly: a 5xx or network failure is retried with the same `Idempotency-Key` (Stripe
replays the first result), and when retries run out the error names the key and says how to check.

## Testing
```bash
npm test          # from the repo root
```
Contract suite for every operation (form encoding, headers, pagination, idempotency, redaction), plus the amount
cap, currency allowlist, `client_secret` stripping and `api_request` allowlist.
Live check: the example with an invalid key gives
`auth_error: API error 401: Invalid API Key provided: sk_test_******d000`.

## License
Apache-2.0
