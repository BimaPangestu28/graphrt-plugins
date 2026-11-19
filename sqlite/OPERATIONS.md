# sqlite operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `sqlite.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `query` | Runs one parameterised SQL statement on a read-only connection, so it cannot change the file. Returns rows (objects), fields, row_count and truncated | database, **sql**, params, max_rows, statement_timeout_ms |
| `execute` | Runs one parameterised INSERT/UPDATE/DELETE/DDL statement (autocommitted). Returns changes, last_insert_rowid and any RETURNING rows. Agents need SQLITE_TOOL_ALLOW_WRITES=1 | database, **sql**, params, max_rows, statement_timeout_ms, create_if_missing |
| `explain` | Shows SQLite's plan for one statement (EXPLAIN QUERY PLAN) on a read-only connection; the statement is not run | database, **sql**, params, statement_timeout_ms |
| `list_tables` | Lists the tables (and views) in a SQLite database file with their CREATE statements | database, include_views, max_rows |
| `describe_table` | Columns (type, nullable, default, primary key position), primary key, indexes and foreign keys of one table or view | database, **table** |
