# weaviate operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `weaviate.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_meta` | Weaviate version, hostname and enabled modules |  |
| `list_collections` | Collections (classes) with their properties, vectorizer and index settings |  |
| `get_collection` | One collection's schema: properties and data types, vectorizer, module and index config | **collection** |
| `get_nodes_status` | Cluster nodes with status, version and (verbose) shard and object counts per collection | output |
| `search_objects` | Search a collection: near_text, near_vector, near_object, hybrid_query or bm25_query (one at a time, or none to list), with a where filter; objects with _additional id, distance or score | **collection**, properties, near_text, near_vector, near_object, hybrid_query, bm25_query, search_properties, alpha, fusion_type, hybrid_vector, distance, target_vectors, where, limit, offset, autocut, after, include_vector, tenant |
| `count_objects` | Number of objects in a collection, optionally matching a where filter (count) | **collection**, where, tenant |
| `list_objects` | Objects of a collection in UUID order, page by page (next_cursor is the last object's id) | **collection**, include, tenant, cursor, limit |
| `get_object` | One object by collection and UUID with its properties (and vector with include: vector) | **collection**, **object_id**, include, tenant, consistency_level |
| `create_object` | Add an object (vectorized by the collection's vectorizer unless you pass vector); fails when the id exists (as an agent tool only when WEAVIATE_TOOL_ALLOW_WRITES=1) | **collection**, properties, object_uuid, vector, vectors, tenant, consistency_level |
| `update_object` | Merge property values into an object (JSON merge patch); the object is re-vectorized when needed (as an agent tool only when WEAVIATE_TOOL_ALLOW_WRITES=1) | **collection**, **object_id**, properties, vector, vectors, tenant, consistency_level |
| `batch_objects` | Add or replace many objects in one request (objects with an existing id are replaced); check each result's errors (as an agent tool only when WEAVIATE_TOOL_ALLOW_WRITES=1) | **objects**, consistency_level |
| `delete_object` | Delete one object by collection and UUID | **collection**, **object_id**, tenant, consistency_level |
| `graphql_query` | Run a raw GraphQL query (Get, Aggregate, Explore; generative search and vectorizers may bill your model provider) (as an agent tool only when WEAVIATE_TOOL_ALLOW_RAW_GRAPHQL=1) | **query**, variables |
| `api_request` | Call any Weaviate REST API endpoint that has no dedicated operation, e.g. path "/v1/schema/<collection>/shards". Only the API's own host is allowed. | method, **path**, query, body |
