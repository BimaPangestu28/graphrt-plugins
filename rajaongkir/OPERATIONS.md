# rajaongkir operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `rajaongkir.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `search_domestic_destinations` | Find destination ids for cost quotes by city, district, village or postal code: id, label, province/city/district/subdistrict, zip_code | **search**, cursor, limit |
| `search_international_destinations` | Find country ids for international quotes: country_id, country_name | **search**, cursor, limit |
| `list_provinces` | Indonesian provinces: id, name |  |
| `list_cities` | Cities and regencies in a province: id, name, zip_code | **province_id** |
| `list_districts` | Districts (kecamatan) in a city: id, name, zip_code | **city_id** |
| `list_subdistricts` | Subdistricts (kelurahan/desa) in a district: id, name, zip_code | **district_id** |
| `calculate_domestic_cost` | Shipping cost quotes per courier and service: name, code, service, description, cost (IDR), etd | **origin**, **destination**, **weight**, **courier**, price |
| `calculate_district_cost` | Shipping cost quotes between two districts (ids from list_districts): name, code, service, cost, etd | **origin**, **destination**, **weight**, **courier**, price |
| `calculate_international_cost` | International quotes from Indonesia: name, code, service, cost, currency, etd | **origin**, **destination**, **weight**, **courier**, price |
| `track_waybill` | Tracking of a waybill (resi): delivered, summary, details, delivery_status and manifest history | **awb**, **courier**, last_phone_number |
| `api_request` | Call any RajaOngkir (Komerce) API endpoint that has no dedicated operation, e.g. path "/destination/province". Only the API's own host is allowed. | method, **path**, query, body |
