# shipper operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `shipper.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `search_locations` | Find areas by name: adm_level_1..5 (country to area) with ids, display_txt and postcodes | **keyword**, adm_level, limit |
| `list_countries` | Countries: country_id, country_name (Indonesia is 228) | cursor, limit |
| `list_provinces` | Provinces of a country | **country_id**, cursor, limit |
| `list_cities` | Cities of a province | **province_id**, cursor, limit |
| `list_suburbs` | Suburbs (kecamatan) of a city | **city_id**, cursor, limit |
| `list_areas` | Areas (kelurahan) of a suburb with postcode, lat and lng | **suburb_id**, cursor, limit |
| `get_domestic_rates` | Courier prices for a parcel: pricings[] with logistic {name, code}, rate {id, name, type}, final_price, insurance, min_day/max_day | **origin**, **destination**, **weight**, **package_length**, **package_width**, **package_height**, **item_value**, item_categories, for_order, cod_amount, rate_types, sort_by |
| `create_order` | Create a shipment order with a rate_id from get_domestic_rates; returns data.order_id. A courier is dispatched after request_pickup | **consignee**, **consigner**, coverage, **courier**, **origin**, **destination**, **package**, external_id, payment_type |
| `get_order` | One order with awb_number, shipment_status and trackings [{shipper_status, logistic_status, created_date}] | **order_id** |
| `get_order_by_external_id` | The order created with your external_id, with its tracking | **external_id** |
| `cancel_order` | Cancel an order before pickup | **order_id**, **reason** |
| `request_pickup` | Activate orders for pickup at a time: a courier is dispatched | **order_ids**, pickup_time |
| `create_label` | A printable label (LBL) or receipt (RCP) for orders: data with the document URL | **order_ids**, label_type |
| `api_request` | Call any Shipper API v3 endpoint that has no dedicated operation, e.g. path "/v3/location/countries". Only the API's own host is allowed. | method, **path**, query, body |
