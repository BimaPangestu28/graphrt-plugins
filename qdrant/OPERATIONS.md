# qdrant operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `qdrant.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_collections` | Names of all collections |  |
| `get_collection` | Collection info: status, point and indexed vector counts, vector config (size, distance), payload schema | **collection_name** |
| `collection_exists` | Whether a collection exists ({exists: true\|false}) | **collection_name** |
| `list_aliases` | Collection aliases ({alias_name, collection_name}) |  |
| `create_collection` | Create a collection, e.g. vectors {"size": 768, "distance": "Cosine"} or named vectors {"text": {...}} (as an agent tool only when QDRANT_TOOL_ALLOW_WRITES=1) | **collection_name**, **vectors**, sparse_vectors, on_disk_payload, shard_number, replication_factor |
| `delete_collection` | Delete a collection and all its points | **collection_name** |
| `query_points` | Universal search: nearest neighbours of a vector or point, recommend, hybrid (prefetch + fusion), order by payload; returns scored points | **collection_name**, query, using, prefetch, filter, score_threshold, search_params, with_payload, with_vector, shard_key, consistency, result_limit, result_offset |
| `query_points_groups` | Like query_points, but grouped by a payload field (e.g. best chunks per document) | **collection_name**, query, using, prefetch, filter, score_threshold, search_params, with_payload, with_vector, shard_key, consistency, **group_by**, group_size, group_limit |
| `scroll_points` | Page through points matching a filter (by id, or ordered by a payload field), with payload | **collection_name**, filter, order_by, with_payload, with_vector, shard_key, consistency, cursor, limit |
| `get_points` | Points by ids with payload (and vectors if asked) | **collection_name**, **ids**, with_payload, with_vector, shard_key, consistency |
| `get_point` | One point by id with payload and vectors | **collection_name**, **point_id**, consistency |
| `count_points` | Number of points matching a filter ({count}) | **collection_name**, filter, exact, shard_key, consistency |
| `facet_counts` | Distinct values of an indexed payload field with their point counts (hits: [{value, count}]) | **collection_name**, **key**, filter, facet_limit, exact, consistency |
| `upsert_points` | Insert or overwrite points by id: [{"id": 1 \| "uuid", "vector": [...] \| {"name": [...]}, "payload": {...}}] (as an agent tool only when QDRANT_TOOL_ALLOW_WRITES=1) | **collection_name**, **points**, update_filter, shard_key, wait |
| `set_payload` | Merge payload fields into points chosen by ids or by a filter (other fields are kept) (as an agent tool only when QDRANT_TOOL_ALLOW_WRITES=1) | **collection_name**, **payload**, points, filter, key, shard_key, wait |
| `delete_points` | Delete points by ids, or every point matching a filter | **collection_name**, points, filter, shard_key, wait |
| `api_request` | Call any Qdrant REST API endpoint that has no dedicated operation, e.g. path "/collections/<collection_name>/optimizations". Only the API's own host is allowed. | method, **path**, query, body |
