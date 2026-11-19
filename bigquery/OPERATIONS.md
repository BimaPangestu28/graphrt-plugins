# bigquery operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `bigquery.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_datasets` | List the datasets of a project | project_id, filter, limit, cursor |
| `list_tables` | List the tables and views of a dataset | project_id, **dataset_id**, limit, cursor |
| `get_table` | Get a table's schema (nested fields flattened), row and byte counts, partitioning and clustering | project_id, **dataset_id**, **table_id** |
| `query` | Run one GoogleSQL query with @named or ? parameters; returns typed rows and next_cursor. Every query is capped by maximum_bytes_billed (at most BIGQUERY_MAX_BYTES_BILLED); dry_run estimates bytes for free. As an agent tool only SELECT runs unless BIGQUERY_TOOL_ALLOW_WRITES=1 | **sql**, params, dry_run, maximum_bytes_billed, default_dataset, location, use_query_cache, labels, project_id, max_rows, wait_ms |
| `get_query_results` | Next page of a query's rows (or wait for a query that was still running), from a query's next_cursor | **cursor**, max_rows, wait_ms |
