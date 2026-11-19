# shopify operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `shopify.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_shop` | The store's name, domains and currency; a cheap way to check the token |  |
| `list_products` | List products with their first 20 variants, newest first | query, reverse, cursor, limit |
| `get_product` | Retrieve a product with its description and first 20 variants | **product_id** |
| `list_orders` | List orders, newest first (orders older than 60 days need the read_all_orders scope) | query, reverse, cursor, limit |
| `get_order` | Retrieve an order with its line items | **order_id** |
| `list_customers` | List customers, newest first | query, reverse, cursor, limit |
| `get_customer` | Retrieve a customer | **customer_id** |
| `list_locations` | List the store's locations (for inventory) | cursor, limit |
| `list_inventory_levels` | Quantities (available, committed, incoming, on_hand, reserved) of one inventory item per location | **inventory_item_id**, cursor, limit |
| `create_product` | Create a product (DRAFT by default); variants and prices are set in the admin or a node (as an agent tool only when SHOPIFY_TOOL_ALLOW_PRODUCTS=1) | **product_title**, description_html, vendor, product_type, tags, status |
| `update_product` | Update a product's title, description, vendor, type, tags or status (as an agent tool only when SHOPIFY_TOOL_ALLOW_PRODUCTS=1) | **product_id**, product_title, description_html, vendor, product_type, tags, status |
| `adjust_inventory` | Change inventory quantities by a delta per item and location | **reason**, quantity_name, reference_document_uri, **changes**, idempotency_key |
| `update_order` | Edit an order's note, tags or email | **order_id**, note, tags, email |
| `create_refund` | Refund line items, shipping or an amount of an order: money goes back to the customer | **order_id**, note, notify, refund_line_items, shipping, transactions, idempotency_key |
| `cancel_order` | Cancel an order (asynchronous job), optionally refunding to the original payment methods and restocking | **order_id**, **reason**, **restock**, refund_to_original_payment, notify_customer, staff_note |
