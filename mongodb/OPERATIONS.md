# mongodb operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `mongodb.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `find` | Find documents in a collection with an Extended JSON filter, projection and sort. Returns up to `limit` documents (max 1000, and at most MONGODB_MAX_RESULT_BYTES) and a next_cursor for the next page. | database, **collection**, filter, projection, sort, limit, skip, cursor, max_time_ms |
| `find_one` | Return the first document that matches an Extended JSON filter (optionally sorted and projected), or null. | database, **collection**, filter, projection, sort, max_time_ms |
| `count` | Count the documents that match an Extended JSON filter (an empty filter counts the whole collection). | database, **collection**, filter, max_time_ms |
| `distinct` | List the distinct values of a field (dotted paths allowed) among documents that match a filter; at most 1000 values. | database, **collection**, **field**, filter, max_time_ms |
| `aggregate` | Run an aggregation pipeline (Extended JSON stages) on a collection and return up to `limit` documents. Agent tool calls may only use allowlisted stages and operators (no JavaScript, no $out), and $merge only with MONGODB_TOOL_ALLOW_WRITES=1. | database, **collection**, **pipeline**, limit, allow_disk_use, max_time_ms |
| `list_databases` | List the databases the connection's user may see, with their size on disk. Agent tool calls only see the databases they may use. |  |
| `list_collections` | List the collections and views in a database (at most 1000 names). | database |
| `insert_one` | Insert one document (Extended JSON). Returns its _id. Agent tool calls need MONGODB_TOOL_ALLOW_WRITES=1. | database, **collection**, **document**, max_time_ms |
| `insert_many` | Insert up to 1000 documents (Extended JSON). Returns their _ids. Agent tool calls need MONGODB_TOOL_ALLOW_WRITES=1. | database, **collection**, **documents**, ordered, max_time_ms |
| `update_one` | Apply update operators ($set, $inc, $push…) to the first document that matches the filter. Agent tool calls need MONGODB_TOOL_ALLOW_WRITES=1. | database, **collection**, **filter**, **update**, upsert, max_time_ms |
| `update_many` | Apply update operators to every document that matches the filter. An empty filter needs `allow_all: true` (workflow nodes only). Agent tool calls need MONGODB_TOOL_ALLOW_WRITES=1. | database, **collection**, **filter**, **update**, upsert, allow_all, max_time_ms |
| `replace_one` | Replace the first document that matches the filter with a new document (no update operators). Agent tool calls need MONGODB_TOOL_ALLOW_WRITES=1. | database, **collection**, **filter**, **replacement**, upsert, max_time_ms |
| `delete_one` | Delete the first document that matches the filter. Agent tool calls need MONGODB_TOOL_ALLOW_WRITES=1. | database, **collection**, **filter**, max_time_ms |
| `delete_many` | Delete every document that matches the filter. An empty filter needs `allow_all: true` (workflow nodes only). Agent tool calls need MONGODB_TOOL_ALLOW_WRITES=1. | database, **collection**, **filter**, allow_all, max_time_ms |
