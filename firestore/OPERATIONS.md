# firestore operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `firestore.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_document` | Read one document by path (fields decoded to plain JSON) | **path**, mask, value_format |
| `list_documents` | List the documents of a collection (or subcollection), paginated with next_cursor | **collection_path**, order_by, mask, limit, cursor, value_format |
| `run_query` | Query a collection (or a collection group) with where filters (AND), order_by, select, limit and offset | **collection_id**, parent_path, all_descendants, where, order_by, select, limit, offset, value_format |
| `create_document` | Create a document in a collection (with document_id, or an auto id); fails if it already exists (as an agent tool only when FIRESTORE_TOOL_ALLOW_WRITES=1) | **collection_path**, document_id, **fields**, value_format |
| `update_document` | Update a document: merge (default) sets only the given top-level fields and removes delete_fields; merge false replaces the whole document (as an agent tool only when FIRESTORE_TOOL_ALLOW_WRITES=1) | **path**, **fields**, merge, delete_fields, must_exist, value_format |
| `delete_document` | Delete a document (its subcollections are not deleted); workflow nodes only | **path**, must_exist |
