# stripe operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `stripe.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_customers` | List customers, newest first, optionally by exact email | email, created_gte, created_lte, cursor, limit |
| `search_customers` | Search customers with Stripe search syntax, e.g. email~'ana' or metadata['crm_id']:'42' (not for read-after-write: results lag up to a minute) | **query**, cursor, limit |
| `get_customer` | Retrieve a customer | **customer_id** |
| `create_customer` | Create a customer (as an agent tool only when STRIPE_TOOL_ALLOW_WRITE=1) | email, name, phone, description, metadata |
| `update_customer` | Update a customer's email, name, phone, description or metadata (as an agent tool only when STRIPE_TOOL_ALLOW_WRITE=1) | **customer_id**, email, name, phone, description, metadata |
| `list_payment_intents` | List PaymentIntents, newest first (client_secret is removed for agent tools) | customer, created_gte, created_lte, cursor, limit |
| `get_payment_intent` | Retrieve a PaymentIntent (client_secret is removed for agent tools) | **payment_intent_id** |
| `create_payment_intent` | Create an unconfirmed PaymentIntent (no money moves until it is confirmed with confirm_payment_intent or by the customer with its client_secret). Agent tools also need STRIPE_TOOL_MAX_AMOUNT and the currency in STRIPE_TOOL_ALLOWED_CURRENCIES (as an agent tool only when STRIPE_TOOL_ALLOW_PAYMENT_INTENTS=1) | **amount**, **currency**, customer, description, capture_method, automatic_payment_methods, statement_descriptor_suffix, metadata |
| `confirm_payment_intent` | Confirm a PaymentIntent with a payment method: this charges the customer | **payment_intent_id**, payment_method, off_session, return_url |
| `capture_payment_intent` | Capture the held funds of a PaymentIntent created with capture_method=manual | **payment_intent_id**, amount_to_capture |
| `cancel_payment_intent` | Cancel a PaymentIntent (releases any hold) | **payment_intent_id**, cancellation_reason |
| `list_payment_links` | List payment links | active, cursor, limit |
| `create_payment_link` | Create a shareable checkout link (buy.stripe.com) for existing prices; money moves only when a customer pays it (as an agent tool only when STRIPE_TOOL_ALLOW_PAYMENT_LINKS=1) | **line_items**, allow_promotion_codes, metadata |
| `list_invoices` | List invoices, newest first | customer, status, subscription, created_gte, created_lte, cursor, limit |
| `get_invoice` | Retrieve an invoice | **invoice_id** |
| `create_invoice` | Create a draft invoice for a customer (auto_advance off: nothing is finalized or sent until finalize_invoice / send_invoice) (as an agent tool only when STRIPE_TOOL_ALLOW_WRITE=1) | **customer**, collection_method, days_until_due, currency, description, metadata |
| `add_invoice_item` | Add a line (a price, or an amount with a description) to a draft invoice. Node only: a draft can be a subscription renewal that Stripe finalizes and charges automatically | **customer**, **invoice**, price, quantity, amount, currency, description, metadata |
| `finalize_invoice` | Finalize a draft invoice so it can be paid (and, with charge_automatically, charged) | **invoice_id**, auto_advance |
| `send_invoice` | Email an open invoice to the customer | **invoice_id** |
| `pay_invoice` | Attempt to collect an open invoice now (charges the customer's payment method) | **invoice_id**, paid_out_of_band |
| `list_products` | List products | active, cursor, limit |
| `get_product` | Retrieve a product | **product_id** |
| `create_product` | Create a product (as an agent tool only when STRIPE_TOOL_ALLOW_WRITE=1) | **name**, description, active, metadata |
| `list_prices` | List prices, optionally of one product | product, active, currency, cursor, limit |
| `create_price` | Create a one-time or recurring price for a product (as an agent tool only when STRIPE_TOOL_ALLOW_WRITE=1) | **product**, **unit_amount**, **currency**, recurring_interval, nickname, metadata |
| `list_charges` | List charges, newest first | customer, payment_intent, created_gte, created_lte, cursor, limit |
| `get_charge` | Retrieve a charge | **charge_id** |
| `get_balance` | Available and pending balance per currency |  |
| `list_balance_transactions` | List balance transactions (charges, refunds, fees, payouts...), newest first | transaction_type, payout, currency, created_gte, created_lte, cursor, limit |
| `list_refunds` | List refunds, newest first | charge, payment_intent, cursor, limit |
| `create_refund` | Refund a charge or PaymentIntent, fully or partly: money goes back to the customer | payment_intent, charge, amount, reason, metadata |
| `list_subscriptions` | List subscriptions (default: not canceled) | customer, price, status, cursor, limit |
| `get_subscription` | Retrieve a subscription | **subscription_id** |
| `cancel_subscription` | Cancel a subscription immediately | **subscription_id**, invoice_now, prorate |
| `api_request` | Call any Stripe API endpoint that has no dedicated operation, e.g. path "/v1/balance". Only the API's own host is allowed. | method, **path**, query, body |
