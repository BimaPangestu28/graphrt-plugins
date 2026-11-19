# paypal operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `paypal.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `create_order` | Create a checkout order; send the buyer its approve (payer-action) link. No money moves until the buyer approves and a node captures it. Agent tools also need PAYPAL_TOOL_MAX_AMOUNT and the currencies in PAYPAL_TOOL_ALLOWED_CURRENCIES (as an agent tool only when PAYPAL_TOOL_ALLOW_ORDERS=1) | intent, **purchase_units**, return_url, cancel_url, brand_name |
| `get_order` | Retrieve an order (status CREATED, APPROVED, COMPLETED...) | **order_id** |
| `capture_order` | Capture an approved order: this charges the buyer | **order_id** |
| `authorize_order` | Authorize an approved AUTHORIZE-intent order (places a hold) | **order_id** |
| `get_capture` | Retrieve a captured payment | **capture_id** |
| `refund_capture` | Refund a captured payment fully (no amount) or partly: money goes back to the buyer | **capture_id**, amount_value, amount_currency_code, note_to_payer, invoice_id |
| `get_refund` | Retrieve a refund | **refund_id** |
| `get_authorization` | Retrieve an authorized payment | **authorization_id** |
| `capture_authorization` | Capture an authorized payment fully or partly: this charges the buyer | **authorization_id**, amount_value, amount_currency_code, final_capture |
| `void_authorization` | Void an authorized payment (releases the hold) | **authorization_id** |
| `list_invoices` | List invoices, newest first | cursor, limit |
| `get_invoice` | Retrieve an invoice | **invoice_id** |
| `create_invoice` | Create a draft invoice (nothing is emailed until send_invoice) (as an agent tool only when PAYPAL_TOOL_ALLOW_INVOICES=1) | **currency_code**, invoice_number, note, term, payment_term_type, primary_recipients, items |
| `send_invoice` | Send a draft invoice: PayPal emails it to the recipients | **invoice_id**, send_to_recipient, subject, note |
| `get_balances` | Account balances per currency | currency_code, as_of_time |
| `list_transactions` | Transactions between two dates (at most 31 days apart; data lags up to 3 hours) | **start_date**, **end_date**, transaction_id, transaction_status, fields, cursor, limit |
| `create_payout` | Send money to up to 15000 recipients by email, phone or PayPal id | **sender_batch_id**, email_subject, **payout_items** |
| `get_payout_batch` | Retrieve a payout batch and its items | **payout_batch_id** |
| `api_request` | Call any PayPal REST API endpoint that has no dedicated operation, e.g. path "/v1/reporting/balances". Only the API's own host is allowed. | method, **path**, query, body |
