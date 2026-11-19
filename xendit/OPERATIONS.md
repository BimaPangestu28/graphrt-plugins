# xendit operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `xendit.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `create_invoice` | Create a hosted payment page (invoice_url) for an amount; send invoice_url to the payer. No money moves until the payer pays. Agent tools also need XENDIT_TOOL_MAX_AMOUNT and the currency in XENDIT_TOOL_ALLOWED_CURRENCIES (as an agent tool only when XENDIT_TOOL_ALLOW_INVOICES=1) | **external_id**, **amount**, currency, description, payer_email, invoice_duration, items, customer, payment_methods, success_redirect_url, failure_redirect_url |
| `get_invoice` | Retrieve an invoice (status PENDING, PAID, SETTLED or EXPIRED) | **invoice_id** |
| `list_invoices` | List invoices, newest first | external_id, statuses, created_after, created_before, paid_after, paid_before, cursor, limit |
| `expire_invoice` | Expire a pending invoice so it can no longer be paid | **invoice_id** |
| `create_payment_request` | Start collecting a payment through one channel (Payments API v3); with a payment_token_id it can charge a saved method at once | **reference_id**, request_type, **currency**, request_amount, country, channel_code, channel_properties, payment_token_id, capture_method, customer_id, description, metadata |
| `get_payment_request` | Retrieve a payment request (status, actions, latest_payment) | **payment_request_id** |
| `get_balance` | Account balance (CASH by default) | account_type, currency, at_timestamp |
| `list_transactions` | List money movements (payments, refunds, payouts, fees), newest first | types, statuses, channel_categories, reference_id, currency, created_gte, created_lte, cursor, limit |
| `create_refund` | Refund a payment request or invoice payment, fully or partly: money goes back to the payer | payment_request_id, invoice_id, reference_id, amount, currency, **reason**, metadata |
| `get_refund` | Retrieve a refund | **refund_id** |
| `create_payout` | Send money from your balance to a bank account or e-wallet (Payouts v3) | **reference_id**, **recipient**, **payout_details**, **source_of_fund**, **purpose_code**, description, metadata |
| `get_payout` | Retrieve a payout (Payouts v3) | **payout_id** |
| `api_request` | Call any Xendit API endpoint that has no dedicated operation, e.g. path "/balance". Only the API's own host is allowed. | method, **path**, query, body |
