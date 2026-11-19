# elasticsearch operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `elasticsearch.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_cluster_info` | Cluster name, uuid and version (version.number, build flavor) of the connected cluster |  |
| `get_cluster_health` | Cluster health: status (green/yellow/red), node counts, active/unassigned shards | level |
| `list_indices` | Indices with health, status, document count and size (_cat/indices as JSON); hidden and system indices are not listed | health, columns, sort_by, bytes |
| `get_mapping` | Field mappings (types) of an index, keyed by index name | **index** |
| `search` | Search documents with the Query DSL; hits are in hits.hits[]._source, totals in hits.total, aggregations in aggregations | **index**, query, size, from, sort, search_after, source_fields, fields, aggs, highlight, knn, track_total_hits, search_timeout, routing |
| `count` | Number of documents matching a query (count) | **index**, query, routing |
| `esql_query` | Run an ES\|QL query (read-only language), e.g. "FROM logs-* \| WHERE status >= 500 \| STATS c = COUNT(*) BY host \| LIMIT 10"; columns and values are returned (as an agent tool only when ELASTICSEARCH_TOOL_ALLOW_ESQL=1) | **query**, params, filter, columnar |
| `get_document` | One document by _id; the document is in _source (found: false when missing returns not_found) | **index**, **doc_id**, source_includes, routing |
| `multi_get` | Several documents of one index by _id (docs[] with found and _source) | **index**, **ids**, source_includes |
| `index_document` | Create or replace the document with this _id (result: created or updated) (as an agent tool only when ELASTICSEARCH_TOOL_ALLOW_WRITES=1) | **index**, **doc_id**, **document**, refresh, routing |
| `create_document` | Add a document with a generated _id (returned as _id) (as an agent tool only when ELASTICSEARCH_TOOL_ALLOW_WRITES=1) | **index**, **document**, refresh, routing |
| `update_document` | Merge fields into a document (partial update; no scripts); doc_as_upsert creates it when missing (as an agent tool only when ELASTICSEARCH_TOOL_ALLOW_WRITES=1) | **index**, **doc_id**, **doc**, doc_as_upsert, refresh, retry_on_conflict, routing |
| `delete_document` | Delete one document by _id | **index**, **doc_id**, refresh, routing |
| `delete_by_query` | Delete every document matching a query (deleted, failures) | **index**, **query**, refresh, conflicts |
| `bulk` | Many index/create/update/delete actions in one request; lines alternate action and source, e.g. [{"index": {"_index": "docs", "_id": "1"}}, {"title": "A"}]; check errors and items[] | **lines**, refresh |
| `api_request` | Call any Elasticsearch REST API endpoint that has no dedicated operation, e.g. path "/<index>/_settings". Only the API's own host is allowed. | method, **path**, query, body |
