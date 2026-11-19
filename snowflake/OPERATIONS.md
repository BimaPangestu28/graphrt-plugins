# snowflake operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `snowflake.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `execute` | Run one SQL statement with ? bindings and return typed rows (paged with next_cursor). As an agent tool only read-only statements (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN) run unless SNOWFLAKE_TOOL_ALLOW_WRITES=1 | **statement**, bindings, database, schema, warehouse, role, timeout_seconds, wait, query_tag, max_rows |
| `get_statement_status` | Check a statement started by execute; waits up to SNOWFLAKE_WAIT_MS and returns its first page of rows when it has finished | **statement_handle**, wait, max_rows |
| `get_statement_results` | Next page of a finished statement's rows (across result partitions), from a next_cursor | **cursor**, max_rows |
| `cancel_statement` | Cancel a running statement | **statement_handle** |
