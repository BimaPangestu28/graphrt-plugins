# postgres operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `postgres.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `query` | Runs one parameterised SQL statement in a READ ONLY transaction that is always rolled back, so it cannot change data. Returns rows (objects), fields, row_count and truncated | **sql**, params, max_rows, statement_timeout_ms |
| `execute` | Runs one parameterised INSERT/UPDATE/DELETE/DDL statement and commits it. Returns command, affected_rows and any RETURNING rows. Agents need POSTGRES_TOOL_ALLOW_WRITES=1 | **sql**, params, max_rows, statement_timeout_ms, in_transaction |
| `explain` | Shows PostgreSQL's plan for one statement (EXPLAIN), in a read-only transaction. With analyze it also runs the statement, still read-only | **sql**, params, analyze, format, statement_timeout_ms |
| `list_tables` | Lists tables (and views) you can access, with their schema. Without `schema`, all non-system schemas | schema, include_views, max_rows |
| `describe_table` | Columns (type, nullable, default, comment), primary key, indexes and foreign keys of one table or view | **table**, schema |
