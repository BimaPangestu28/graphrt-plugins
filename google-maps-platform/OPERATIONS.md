# google-maps-platform operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `google-maps-platform.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `search_text` | Find places from a text query such as "coffee near Monas Jakarta": places with id, name, address, location, Maps URL | **text_query**, included_type, strict_type_filtering, open_now, min_rating, price_levels, location_bias, location_restriction, language_code, region_code, field_mask, cursor, limit |
| `search_nearby` | Places of given types within a radius of a point, by popularity or distance | **latitude**, **longitude**, **radius_meters**, included_types, excluded_types, max_result_count, rank_preference, language_code, region_code, field_mask |
| `get_place` | Details of one place by id; ask for rating, phone, website or opening hours through field_mask | **place_id**, language_code, region_code, session_token, field_mask |
| `autocomplete_places` | Place and query predictions for partial input (suggestions[].placePrediction.placeId and text) | **input**, included_primary_types, included_region_codes, include_query_predictions, location_bias, origin, session_token, language_code, region_code |
| `get_place_photo` | A short-lived photoUri for a photo from a place's photos[].name | **photo_name**, max_width_px, max_height_px |
| `geocode_address` | Address to coordinates: results[] with placeId, formattedAddress, location {latitude, longitude}, addressComponents, types | **address**, language_code, region_code |
| `reverse_geocode` | Coordinates to addresses: results[] with formattedAddress, placeId, addressComponents, types | **latitude**, **longitude**, language_code, region_code |
| `compute_routes` | Route between two waypoints (optionally via intermediates): distanceMeters, duration (e.g. '1234s'), localized values | **origin**, **destination**, intermediates, travel_mode, routing_preference, language_code, units, compute_alternative_routes, route_modifiers, departure_time, field_mask |
| `compute_route_matrix` | Distance and duration for every origin-destination pair (billed per element): [{originIndex, destinationIndex, distanceMeters, duration, condition}] | **origins**, **destinations**, travel_mode, routing_preference, language_code, units, field_mask |
