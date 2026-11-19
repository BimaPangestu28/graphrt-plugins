# midtrans operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `midtrans.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `create_snap_transaction` | Create a Snap payment page for an order: returns token and redirect_url (send redirect_url to the payer). No money moves until the payer pays. Agent tools also need MIDTRANS_TOOL_MAX_AMOUNT (as an agent tool only when MIDTRANS_TOOL_ALLOW_PAYMENTS=1) | **order_id**, **gross_amount**, item_details, customer_details, enabled_payments, expiry_duration, expiry_unit, custom_field1, custom_field2, custom_field3 |
| `get_transaction_status` | Status of a transaction by order id: transaction_status (pending, settlement, capture, deny, cancel, expire, refund...), payment_type, gross_amount | **order_id** |
| `get_b2b_transaction_status` | All transactions of one order id (B2B: several payments per order) | **order_id**, page, per_page |
| `cancel_transaction` | Cancel a pending or captured (not yet settled) transaction | **order_id** |
| `expire_transaction` | Expire a pending transaction so it can no longer be paid | **order_id** |
| `refund_transaction` | Refund a settled transaction fully or partly: money goes back to the payer | **order_id**, refund_key, amount, reason |
| `direct_refund_transaction` | Refund through the payment provider at once (GoPay, ShopeePay, QRIS, cards): money goes back to the payer | **order_id**, refund_key, amount, reason |
| `approve_transaction` | Accept a card transaction flagged as challenge by fraud detection | **order_id** |
| `deny_transaction` | Reject a card transaction flagged as challenge by fraud detection | **order_id** |
| `capture_transaction` | Capture an authorized (pre-auth) card transaction | **transaction_id**, gross_amount |
| `api_request` | Call any Midtrans Core API endpoint that has no dedicated operation, e.g. path "/v2/ORDER-1/status". Only the API's own host is allowed. | method, **path**, query, body |
