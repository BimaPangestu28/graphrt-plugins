# lazada operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `lazada.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_seller` | The authorized seller: name, email, location, verification status; a cheap way to check the token |  |
| `list_products` | List products with their SKUs (price, stock, status) | filter, create_after, update_after, seller_skus, limit, cursor |
| `get_product` | Retrieve one product by item_id or seller_sku | item_id, seller_sku |
| `list_orders` | List orders created or updated after a time, optionally by status | created_after, created_before, update_after, update_before, status, sort_by, sort_direction, limit, cursor |
| `get_order` | Retrieve one order (buyer, address, totals, statuses) | **order_id** |
| `get_order_items` | The items of one order (order_item_id, SKU, price, status, package and tracking) | **order_id** |
| `get_multiple_order_items` | The items of up to 50 orders in one call | **order_ids** |
| `update_price_quantity` | Set price, sale price (with dates) and/or quantity of up to 50 SKUs. After a network error or timeout the change may still have been applied: check before retrying. Check with get_product. | **skus** |
| `update_sellable_stock` | Set the sellable quantity of up to 50 SKUs (multi-warehouse aware). After a network error or timeout the change may still have been applied: check before retrying. Check with get_product. | **skus** |
| `pack_order` | Pack order items for shipping (/order/fulfill/pack): returns the package ids. After a network error or timeout the change may still have been applied: check before retrying. Check with get_order_items. | **pack_request** |
| `ready_to_ship` | Set packed packages ready to ship (/order/package/rts), which books the pickup. After a network error or timeout the change may still have been applied: check before retrying. Check with get_order_items. | **ready_to_ship_request** |
| `api_request` | Call any Lazada Open Platform endpoint that has no dedicated operation, e.g. path "/finance/transaction/details/get". Only the API's own host is allowed. | method, **path**, query, body |
