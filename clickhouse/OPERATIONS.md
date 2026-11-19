# clickhouse operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `clickhouse.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `ping` | Health check: "Ok." when the server is up (no authentication needed) |  |
| `server_info` | Server version, uptime, time zone, current user and default database |  |
| `list_databases` | Databases with their engine and comment |  |
| `list_tables` | Tables of a database with engine, row and byte counts, sorting key and comment | database |
| `describe_table` | Columns of a table: name, type, default, comment, and whether it is in the primary or sorting key | database, **table** |
| `query` | Run one read-only SQL statement (SELECT, SHOW, DESCRIBE, EXPLAIN) with readonly=1, a time limit and result caps; returns JSON {meta, data, rows, statistics} | **sql**, parameters, database, max_execution_time, max_result_rows, max_result_bytes, result_overflow_mode |
| `insert_rows` | Insert rows (objects of column: value) into a table as JSONEachRow; returns written_rows (as an agent tool only when CLICKHOUSE_TOOL_ALLOW_WRITES=1) | **table**, database, **rows**, max_execution_time |
| `execute` | Run any SQL statement (INSERT ... SELECT, CREATE, ALTER, mutations, DROP, TRUNCATE) without readonly; returns JSON output, if any, and the write summary | **sql**, parameters, database, max_execution_time |
