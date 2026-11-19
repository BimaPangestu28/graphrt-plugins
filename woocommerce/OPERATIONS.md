# woocommerce operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `woocommerce.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_products` | List products (newest first by default) | search, sku, status, category, stock_status, orderby, order, cursor, limit |
| `get_product` | Retrieve a product | **product_id** |
| `list_product_variations` | List the variations of a variable product | **product_id**, cursor, limit |
| `update_product` | Update a product's name, descriptions, status, SKU, categories or tags; prices and stock too, but only from workflow nodes (as an agent tool only when WOOCOMMERCE_TOOL_ALLOW_PRODUCTS=1) | **product_id**, name, description, short_description, status, sku, categories, tags, regular_price, sale_price, manage_stock, stock_quantity, stock_status |
| `list_orders` | List orders (newest first by default) | status, customer, search, after, before, orderby, order, cursor, limit |
| `get_order` | Retrieve an order | **order_id** |
| `update_order_status` | Change an order's status (WooCommerce may email the customer, e.g. on completed). Agent tools may only set on-hold (as an agent tool only when WOOCOMMERCE_TOOL_ALLOW_ORDER_STATUS=1) | **order_id**, **status** |
| `list_order_refunds` | List the refunds of an order | **order_id**, cursor, limit |
| `create_refund` | Refund an order (by default through the payment gateway: money goes back to the customer) | **order_id**, **amount**, reason, line_items, api_refund, api_restock |
| `list_customers` | List customers | search, email, role, orderby, order, cursor, limit |
| `get_customer` | Retrieve a customer | **customer_id** |
| `api_request` | Call any WooCommerce REST API endpoint that has no dedicated operation, e.g. path "/reports/sales". Only the API's own host is allowed. | method, **path**, query, body |
