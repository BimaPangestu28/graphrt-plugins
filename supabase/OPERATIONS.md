# supabase operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `supabase.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_api_schema` | OpenAPI description of the exposed tables, views, columns and functions (needs a secret or service_role key since Feb 2026) | db_schema |
| `select_rows` | Read rows of a table or view with filters, column selection (incl. related tables) and ordering; row level security applies to publishable/anon keys | **table**, columns, filters, order, db_schema, cursor, limit |
| `insert_rows` | Insert one or more rows and return them; missing columns get their defaults (as an agent tool only when SUPABASE_TOOL_ALLOW_WRITES=1) | **table**, **rows**, columns, db_schema |
| `upsert_rows` | Insert rows, or update (merge) or skip (ignore) rows whose primary key or on_conflict columns already exist (as an agent tool only when SUPABASE_TOOL_ALLOW_WRITES=1) | **table**, **rows**, on_conflict, duplicates, columns, db_schema |
| `update_rows` | Set column values on every row matching the filters (at least one filter required) and return the changed rows (as an agent tool only when SUPABASE_TOOL_ALLOW_WRITES=1) | **table**, **values**, **filters**, columns, db_schema |
| `delete_rows` | Delete every row matching the filters (at least one filter required) and return the deleted rows | **table**, **filters**, columns, db_schema |
| `call_function` | Call a Postgres function exposed by the Data API (RPC) with named arguments (as an agent tool only when SUPABASE_TOOL_ALLOW_WRITES=1) | **function_name**, arguments, db_schema |
| `list_buckets` | Storage buckets of the project with their public flag, size limit and allowed MIME types |  |
| `get_bucket` | One storage bucket | **bucket_id** |
| `list_objects` | Files and folders under a prefix of a bucket (one level), with size and MIME type in metadata | **bucket_id**, prefix, search, sort_column, sort_order, cursor, limit |
| `get_object_info` | Size, MIME type, ETag and timestamps of one file | **bucket_id**, **object_path** |
| `download_object` | Download a file into SUPABASE_DOWNLOAD_DIR | **bucket_id**, **object_path** |
| `upload_object` | Upload a file (https URL or a path inside SUPABASE_UPLOAD_DIR) to a bucket path; upsert overwrites (node only) (as an agent tool only when SUPABASE_TOOL_ALLOW_WRITES=1) | **bucket_id**, **object_path**, **file**, upsert, cache_control |
| `delete_objects` | Delete up to 1000 files of a bucket by path | **bucket_id**, **paths** |
| `create_signed_url` | A time-limited download URL for a private file (anyone with the link can read it) | **bucket_id**, **object_path**, **expires_in** |
| `api_request` | Call any Supabase project API (Data API /rest/v1, Storage /storage/v1) endpoint that has no dedicated operation, e.g. path "/rest/v1/<table>?select=id&id=eq.1". Only the API's own host is allowed. | method, **path**, query, body |
