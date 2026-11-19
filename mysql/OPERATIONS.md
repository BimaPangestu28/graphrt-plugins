# mysql operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `mysql.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `query` | Runs one parameterised SQL statement in a READ ONLY transaction that is always rolled back, so it cannot change data. Returns rows (objects), fields, row_count and truncated | **sql**, params, max_rows, statement_timeout_ms |
| `execute` | Runs one parameterised INSERT/UPDATE/DELETE/DDL statement (autocommitted). Returns affected_rows, changed_rows and insert_id. Agents need MYSQL_TOOL_ALLOW_WRITES=1 | **sql**, params, max_rows, statement_timeout_ms |
| `explain` | Shows MySQL's plan for one statement (EXPLAIN), in a read-only transaction. With analyze (MySQL 8.0.18+) it also runs the statement, still read-only | **sql**, params, format, analyze, statement_timeout_ms |
| `list_tables` | Lists tables (and views) in a database with approximate row counts. Without `schema`, the connection's database, or every non-system database when there is none | schema, include_views, max_rows |
| `describe_table` | Columns (type, nullable, default, key, extra, comment), primary key, indexes and foreign keys of one table or view | **table**, schema |
