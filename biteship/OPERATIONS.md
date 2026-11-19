# biteship operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `biteship.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_rates` | Shipping prices and ETAs from couriers between two places (area id, postal code or coordinates) for the items | origin_area_id, origin_postal_code, origin_latitude, origin_longitude, destination_area_id, destination_postal_code, destination_latitude, destination_longitude, **couriers**, **items**, courier_insurance, destination_cash_on_delivery, destination_cash_on_delivery_type |
| `list_couriers` | Couriers and services available to the account: courier_code, courier_service_code, tier, duration, COD/insurance support |  |
| `search_areas` | Find area ids for rates and orders by name or postal code: id, name, province/city/district, postal_code | **input**, countries, search_type |
| `create_order` | Book a courier pickup or drop-off for a shipment; the fee is charged to the Biteship balance. Returns id, status, courier.waybill_id | shipper_contact_name, shipper_contact_phone, shipper_contact_email, shipper_organization, **origin_contact_name**, **origin_contact_phone**, origin_contact_email, **origin_address**, origin_note, origin_postal_code, origin_area_id, origin_coordinate, origin_collection_method, **destination_contact_name**, **destination_contact_phone**, destination_contact_email, **destination_address**, destination_note, destination_postal_code, destination_area_id, destination_coordinate, destination_cash_on_delivery, destination_cash_on_delivery_type, **courier_company**, **courier_type**, courier_insurance, **delivery_type**, delivery_date, delivery_time, order_note, reference_id, metadata, tags, **items** |
| `get_order` | One order: status, courier (waybill_id, tracking_id, history), origin, destination, items and price | **order_id** |
| `cancel_order` | Cancel a booked order (only before pickup); see list_cancellation_reasons | **order_id**, **cancellation_reason_code**, cancellation_reason |
| `list_cancellation_reasons` | Codes accepted by cancel_order with descriptions | lang |
| `get_tracking` | Tracking of an order made through Biteship: status, waybill_id, link, courier driver, history [{note, status, updated_at}] | **tracking_id** |
| `track_waybill` | Public tracking of any waybill (also shipments not booked through Biteship): status and history | **waybill_id**, **courier_code** |
| `api_request` | Call any Biteship API endpoint that has no dedicated operation, e.g. path "/v1/couriers". Only the API's own host is allowed. | method, **path**, query, body |
