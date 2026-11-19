# pinecone operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `pinecone.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_indexes` | Indexes in the project with their host (use it as index_host), dimension or schema, status and deployment |  |
| `describe_index` | One index: host (for index_host), status, schema/dimension and metric, deployment, deletion protection | **index_name** |
| `delete_index` | Delete an index and all its data (refused while deletion protection is enabled) | **index_name** |
| `describe_index_stats` | Vector count per namespace, dimension and fullness of the index | index_host, filter |
| `list_namespaces` | Namespaces of the index with their record counts | index_host, prefix, cursor, limit |
| `delete_namespace` | Delete a namespace and every record in it | index_host, **namespace** |
| `query_vectors` | Nearest neighbours of a query vector (or of a stored vector by vector_id), with scores and optional metadata | index_host, **top_k**, vector, vector_id, sparse_vector, namespace, filter, include_metadata, include_values |
| `fetch_vectors` | Vectors by id with values and metadata (`vectors` is a map from id to vector) | index_host, **ids**, namespace |
| `fetch_vectors_by_metadata` | Vectors whose metadata matches a filter, page by page (`vectors` is a map from id to vector) | index_host, **filter**, namespace, cursor, limit |
| `list_vector_ids` | Vector ids in a namespace (serverless indexes), optionally by id prefix, page by page | index_host, prefix, namespace, cursor, limit |
| `upsert_vectors` | Insert or overwrite up to 1000 vectors by id ({id, values, sparseValues?, metadata?}) (as an agent tool only when PINECONE_TOOL_ALLOW_WRITES=1) | index_host, **vectors**, namespace |
| `update_vectors` | Update one vector by vector_id (values, sparse values, merge metadata), or set metadata on every vector matching a filter (as an agent tool only when PINECONE_TOOL_ALLOW_WRITES=1) | index_host, vector_id, values, sparse_values, set_metadata, filter, dry_run, namespace |
| `delete_vectors` | Delete vectors by ids, by metadata filter, or all vectors of a namespace (delete_all) | index_host, ids, filter, delete_all, namespace |
| `search_documents` | Search a document index: score_by clauses (dense_vector, sparse_vector, text, query_string, embed, sparse_embed), top_k matches with _score and fields | index_host, **namespace**, **score_by**, **top_k**, include_fields, filter |
| `fetch_documents` | Documents by ids, or by metadata filter page by page (`documents` is a map from _id to document) | index_host, **namespace**, ids, filter, include_fields, cursor, limit |
| `list_documents` | Document ids in a namespace, optionally by id prefix, page by page | index_host, **namespace**, prefix, cursor, limit |
| `upsert_documents` | Insert or overwrite documents by _id (at most 96 per call when the index embeds text; embedding is billed per call) (as an agent tool only when PINECONE_TOOL_ALLOW_WRITES=1) | index_host, **namespace**, **documents** |
| `update_documents` | Patch documents by _id (documents), or set/remove metadata fields on every document matching a filter (as an agent tool only when PINECONE_TOOL_ALLOW_WRITES=1) | index_host, **namespace**, documents, filter, set_fields, remove_fields |
| `delete_documents` | Delete documents by ids, by metadata filter, or all documents of a namespace (delete_all) | index_host, **namespace**, ids, filter, delete_all |
| `search_records` | Text search on a legacy integrated-embedding index: Pinecone embeds query_text, optional reranking; result.hits with _id, _score, fields | index_host, **namespace**, query_text, query_vector, query_record_id, **top_k**, filter, fields, rerank |
| `api_request` | Call any Pinecone control plane API endpoint that has no dedicated operation, e.g. path "/indexes/<index_name>/backups". Only the API's own host is allowed. | method, **path**, query, body |
