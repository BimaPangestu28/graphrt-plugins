# shopee-api operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `shopee-api.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_shop_info` | Read the authorized Shopee shop: name, region, status, authorization expiry and cross-border flags. |  |
| `get_item_list` | List the shop's item ids with status and update time (offset paging). Use get_item_base_info for details. | item_status, update_time_from, update_time_to, limit, cursor |
| `get_item_base_info` | Read base info (name, status, price info, stock info, images) for up to 50 items. | **item_ids** |
| `update_stock` | Set seller stock for an item or its models (variations). Check failure_list in the result for models Shopee rejected. If this failed with a network error the update may still have been applied: check with get_item_base_info before retrying. | **item_id**, **stock_list** |
| `update_price` | Set the original price of an item or its models (variations). Check failure_list in the result. If this failed with a network error the update may still have been applied: check with get_item_base_info before retrying. | **item_id**, **price_list** |
| `get_order_list` | List order numbers created or updated in a time window of at most 15 days (Unix seconds), optionally by status. | time_range_field, **time_from**, **time_to**, order_status, limit, cursor |
| `get_order_detail` | Read up to 50 orders: items, amounts, buyer, recipient address, packages and shipping carrier. | **order_sns**, response_optional_fields |
| `get_shipping_parameter` | Read what ship_order needs for an order (info_needed) and the pickup addresses/time slots or drop-off branches. | **order_sn**, package_number |
| `ship_order` | Arrange shipment for an order with exactly one of pickup, dropoff or non_integrated, as get_shipping_parameter's info_needed says. If this fails with a network error the order may still have been shipped: check with get_tracking_number or get_order_detail before retrying. | **order_sn**, package_number, pickup, dropoff, non_integrated |
| `get_tracking_number` | Read the tracking number of a shipped order (empty until the carrier assigns one). | **order_sn**, package_number, response_optional_fields |
| `sellerchat_get_conversation_list` | List the shop's buyer chat conversations, newest first, with unread counts and the latest message. | conversation_type, limit, cursor |
| `sellerchat_get_message` | Read messages of one chat conversation, newest first. | **conversation_id**, limit, cursor |
| `sellerchat_send_message` | Send one message to a buyer: text, an image URL, an item card or an order card. Not for bulk messages. If this fails with a network error the message may have been sent: check sellerchat_get_message before retrying. | **to_id**, message_type, text, image_url, item_id, order_sn |
| `refresh_access_token` | Exchange the shop's refresh token for a new access token (valid 4 hours) and a new refresh token (valid 30 days, single use): store both. The partner key is read from SHOPEE_PARTNER_KEY only. | refresh_token, shop_id |
| `api_request` | Call any Shopee Open Platform v2 endpoint that has no dedicated operation, e.g. path "/api/v2/product/get_category". Only the API's own host is allowed. | method, **path**, query, body, api_type |
