# chroma operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `chroma.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `heartbeat` | Check the server is up ({"nanosecond heartbeat": ...}) |  |
| `get_identity` | Who the token belongs to: user id, tenant and the databases it can use |  |
| `list_collections` | Collections of the database with id, name, metadata and configuration | cursor, limit |
| `count_collections` | Number of collections in the database |  |
| `get_collection` | A collection by name: its id (needed by record operations), metadata, configuration and dimension | **collection_name** |
| `create_collection` | Create a collection (or return the existing one with get_or_create) (as an agent tool only when CHROMA_TOOL_ALLOW_WRITES=1) | **name**, metadata, configuration, get_or_create |
| `delete_collection` | Delete a collection by name, with all its records | **collection_name** |
| `count_records` | Number of records in a collection | **collection_id** |
| `get_records` | Records by ids and/or filters (columnar: ids, documents, metadatas, ... arrays of equal length) | **collection_id**, ids, where, where_document, include, record_limit, record_offset |
| `query_records` | Nearest records to one or more query embeddings (one result list per query embedding, with distances) | **collection_id**, **query_embeddings**, n_results, where, where_document, ids, include |
| `search_records` | Search API (Chroma Cloud and recent servers): searches with rank expressions (knn, rrf), filters, select and limit | **collection_id**, **searches**, read_level |
| `add_records` | Add records with embeddings (ids that already exist are left unchanged) (as an agent tool only when CHROMA_TOOL_ALLOW_WRITES=1) | **collection_id**, **ids**, **embeddings**, documents, metadatas, uris |
| `upsert_records` | Insert or overwrite records by id (as an agent tool only when CHROMA_TOOL_ALLOW_WRITES=1) | **collection_id**, **ids**, **embeddings**, documents, metadatas, uris |
| `update_records` | Update embeddings, documents, metadata or URIs of existing records by id (as an agent tool only when CHROMA_TOOL_ALLOW_WRITES=1) | **collection_id**, **ids**, embeddings, documents, metadatas, uris |
| `delete_records` | Delete records by ids and/or a metadata or document filter | **collection_id**, ids, where, where_document |
| `api_request` | Call any Chroma API (database-scoped) endpoint that has no dedicated operation, e.g. path "/collections/<collection_id>/indexing_status". Only the API's own host is allowed. | method, **path**, query, body |
