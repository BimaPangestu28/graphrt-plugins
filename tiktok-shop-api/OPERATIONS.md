# tiktok-shop-api operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `tiktok-shop-api.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_authorized_shops` | List the shops that authorized this app, with each shop's cipher (set TIKTOK_SHOP_CIPHER to it), region and seller type. |  |
| `search_products` | List the shop's products (id, title, status, SKUs) filtered by status, seller SKU or create/update time (Unix seconds). | status, seller_skus, create_time_ge, create_time_le, update_time_ge, update_time_le, limit, cursor |
| `get_product` | Read one product with its SKUs, prices, inventory per warehouse, images and audit status. | **product_id**, locale |
| `update_inventory` | Set the in-stock quantity of SKUs of one product, per warehouse (warehouse_id is optional when the shop has one warehouse). If this fails with a network error the update may still have been applied: check with get_product before retrying. | **product_id**, **skus** |
| `update_price` | Set the price of SKUs of one ACTIVATE product that is not in a promotion. If this fails with a network error the update may still have been applied: check with get_product before retrying. | **product_id**, **currency**, **skus** |
| `search_orders` | List orders by status, buyer or create/update time window (Unix seconds), newest first by default. | order_status, buyer_user_id, create_time_ge, create_time_lt, update_time_ge, update_time_lt, sort_field, sort_order, limit, cursor |
| `get_order_detail` | Read up to 50 orders: status, line items, payment, recipient address and packages (package ids for shipping). | **order_ids** |
| `get_package_shipping_document` | Get the URL (valid 24 hours) of a TikTok Shipping package's label or packing slip, plus its tracking number. Call ship_package first. | **package_id**, document_type, document_size |
| `ship_package` | Ship a package: TikTok Shipping (optional handover_method and pickup slot) or seller shipping (self_shipment with tracking_number and shipping_provider_id). If this fails with a network error the package may already be shipped: check get_order_detail before retrying. | **package_id**, handover_method, pickup_slot, self_shipment |
| `search_returns` | List return, refund, replacement and exchange requests by order, return status or time window (Unix seconds). | order_ids, return_ids, return_status, return_types, create_time_ge, create_time_lt, update_time_ge, update_time_lt, sort_field, sort_order, limit, cursor |
| `get_conversations` | List the shop's conversations with buyers: participants, unread count, latest message and whether the shop can reply. | limit, cursor, locale |
| `get_conversation_messages` | Read messages of one buyer conversation, newest first by default. Does not mark them as read. | **conversation_id**, sort_order, limit, cursor, locale |
| `send_message` | Send one message to the buyer in a conversation: `text` for TEXT, or `content` (e.g. {product_id} for PRODUCT_CARD, {order_id} for ORDER_CARD). If this fails with a network error the message may have been sent: check get_conversation_messages before retrying. | **conversation_id**, type, text, content |
| `refresh_access_token` | Exchange the refresh token for a new access token (auth.tiktok-shops.com) and store the returned access_token and refresh_token. The app secret is read from TIKTOK_SHOP_APP_SECRET only. | refresh_token |
| `api_request` | Call any TikTok Shop API endpoint that has no dedicated operation, e.g. path "/logistics/202309/warehouses". Only the API's own host is allowed. | method, **path**, query, body, include_shop_cipher |
