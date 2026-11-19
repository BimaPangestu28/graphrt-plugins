# mysql

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin that runs parameterised SQL on **MySQL** and
**MariaDB** with the [`mysql2`](https://sidorares.github.io/node-mysql2/docs) driver. Agents get read-only access by
default: `query` runs with the session and the transaction set to `READ ONLY`, so the server itself refuses writes
and DDL.

## Features
- **`query`:** one parameterised statement (`?` placeholders) in a read-only transaction. Returns `rows` (objects),
  `fields` (name and type), `row_count` and `truncated`.
- **`execute`:** one INSERT/UPDATE/DELETE/DDL statement, autocommitted. Returns `affected_rows`, `changed_rows`,
  `insert_id` and `warning_count`. Workflow nodes only, unless `MYSQL_TOOL_ALLOW_WRITES=1`.
- **`explain`:** `EXPLAIN` as rows, JSON or a tree, or `EXPLAIN ANALYZE` (MySQL 8.0.18+), read-only.
- **`list_tables`** and **`describe_table`:** tables and views with approximate row counts, columns (type,
  nullable, default, key, extra, comment), primary key, indexes and foreign keys.
- Every operation is a node `mysql.<operation>` and an agent tool. The full reference is in
  [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20
- graphrt with plugin support
- MySQL 5.7.8+ or 8.x (statement timeouts need `max_execution_time`), or MariaDB 10.1+ (`max_statement_time`).
  Give agents a user with only the privileges they need (see Safety).

## Installation
```bash
cd mysql
npm install          # mysql2 (pinned version)
graphrt plugin install .
```
Without `node_modules/`, every operation fails with `setup_required`.

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `MYSQL_URL` | (none) | Connection URL, e.g. `mysql://app:secret@db.example.com:3306/shop?ssl-mode=VERIFY_IDENTITY` (`mariadb://` works too). Percent-encode special characters. Only `ssl-mode` / `sslmode` is read from the query string; other parameters are ignored. |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` | port `3306` | Used when `MYSQL_URL` is unset |
| `MYSQL_SSL_MODE` | `disable` | `disable`, `require` (TLS without certificate checks) or `verify-full`; MySQL's `DISABLED`, `REQUIRED` and `VERIFY_IDENTITY` work too |
| `MYSQL_STATEMENT_TIMEOUT_MS` | `30000` | Default statement timeout (100 to 600000). Nodes may pass any `statement_timeout_ms`; for agent tool calls this value is also the ceiling. |
| `MYSQL_CONNECT_TIMEOUT_MS` | `10000` | Connect timeout |
| `MYSQL_MAX_RESULT_BYTES` | `1000000` | Most JSON bytes of returned rows per call (1000 to 8000000) |
| `MYSQL_POOL_MAX` | `4` | Connections per pool |
| `MYSQL_TOOL_ALLOW_WRITES` | (off) | `1` lets agents call `execute`. Leave it off unless the user itself is limited. |

**Per-node connection:** a node's `access_token` replaces the connection for that node. Pass a full `mysql://` URL
from a workflow env variable of type `secret` (`env: [{ name: REPORTING_DB_URL, type: secret }]`, then
`access_token: "{{#env.REPORTING_DB_URL#}}"`) and trust the plugin (`--trust-plugin mysql`) so it arrives
unmasked. Tool calls can never choose a connection.

## Quick Start
```bash
export MYSQL_URL=mysql://app:secret@127.0.0.1:3306/shop
graphrt run mysql/example.yaml --plugins .
```

## Usage
```yaml
- id: orders
  type: mysql.query
  sql: "SELECT id, total, created_at FROM orders WHERE customer_id = ? AND created_at >= ? ORDER BY created_at DESC"
  params: ["{{#start.customer_id#}}", "2026-11-01"]
  max_rows: 50
- id: mark
  type: mysql.execute
  sql: "UPDATE orders SET status = ? WHERE id = ?"
  params: ["shipped", "{{#orders.data.rows.0.id#}}"]
```
**Values in results:**
- `BIGINT` (including `COUNT(*)` and integer literals, which MySQL types as BIGINT) and `DECIMAL` are strings, so
  they stay exact.
- `DATETIME` is ISO text without a zone (`2026-11-19T10:00:00.123456`). `TIMESTAMP` is read in UTC and ends in `Z`.
  `DATE` and `TIME` are returned as MySQL writes them, and zero dates (`0000-00-00`) stay unchanged.
- `JSON` columns are JSON values. Binary columns (`BINARY`, `VARBINARY`, `BLOB`, `BIT`) are base64, cut to 64 KiB
  per value (`values_truncated: true` when that happened).
- In `params`, booleans are sent as `1` / `0`, and objects and arrays as JSON text.

## Safety
- **Read-only at the server level:** `query`, `explain`, `list_tables` and `describe_table` run
  `SET SESSION TRANSACTION READ ONLY`, then `START TRANSACTION READ ONLY`, then the statement, then `ROLLBACK`. The
  session setting matters: DDL commits implicitly, and would otherwise escape a read-only transaction. With both,
  the server refuses INSERT/UPDATE/DELETE, CREATE/ALTER/DROP/TRUNCATE, temporary tables and account changes
  (error 1792, `permission_denied`). The SQL is never parsed or rewritten.
- **What read-only does not cover:** `SET GLOBAL`, `KILL`, `SELECT ... INTO OUTFILE` (with the FILE privilege) and
  similar administrative statements are governed by privileges, not by read-only mode. Give agents a user without
  `SUPER`, `SYSTEM_VARIABLES_ADMIN`, `CONNECTION_ADMIN` and `FILE`, ideally one with only `SELECT` on the tables
  they need. `LOAD DATA LOCAL INFILE` is always disabled on the client side.
- **Stored procedures:** a procedure can `COMMIT` and then `START TRANSACTION READ WRITE`, which escapes the
  read-only session. So `query` refuses `CALL` from agent tool calls (`permission_denied`), also when it hides
  behind comments, empty statements (`;CALL`) or an executable comment (`/*!50000 CALL p() */`). Workflow nodes may
  still `CALL` from `query`, and such a procedure can write: give the account nodes use for reads no `EXECUTE`
  privilege, or use `execute` for procedures on purpose. Stored functions cannot commit, so `SELECT f()` stays
  read-only.
- **Session reset:** every connection is reset (`COM_RESET_CONNECTION`) when it goes back to the pool, so user
  variables, temporary tables, session settings and named locks from one call never reach the next. Writes also set
  `SET SESSION TRANSACTION READ WRITE` explicitly.
- **One statement per call:** multiple statements are off; statements with `params` are server-side prepared.
  `SELECT 1; DROP TABLE x` is a syntax error (`invalid_input`). Values only travel in `params`.
- **Agents (tool calls) vs workflows (nodes):** `execute` refuses tool calls with `permission_denied` unless
  `MYSQL_TOOL_ALLOW_WRITES=1`. Workflow nodes you wrote can always call it; a call that is neither a node nor a tool is refused as well.
- **Caps:** at most `max_rows` rows (default 500, at most 5000) and `MYSQL_MAX_RESULT_BYTES` of JSON per call. Rows
  are streamed; at either cap the plugin stops and closes that connection (the server stops sending and rolls the
  read-only transaction back), and `truncated` / `truncated_reason` say so. The bytes arriving on the socket are
  counted as well: past 4 x `MYSQL_MAX_RESULT_BYTES` + 1 MiB (for example many large BLOBs, which shrink to 64 KiB
  each in the result) the connection is closed and the rows so far come back with `truncated_reason: "max_bytes"`.
- **Timeouts and cancel:**
  - Reads set `max_execution_time` (MySQL) or `max_statement_time` (MariaDB), which stops long SELECTs
    (`timeout`). MySQL's `SLEEP()` is the exception: when interrupted it returns `1` instead of failing.
  - Statements the server timeout does not cover (non-SELECT, and every `execute`) get `KILL QUERY` from the plugin
    5 s past `statement_timeout_ms`.
  - Cancelling the run or a passed tool deadline also sends `KILL QUERY`, on a separate connection, and discards
    the pooled one. A read that was killed is always reported as `cancelled` or `timeout`, never as a result.
- **No retries for writes:** `execute` never retries. If the connection is lost or the call is cancelled, the error
  says the statement may or may not have been applied: check before running it again.
- **Secrets:** the password (as typed and percent-encoded), the whole URL and any `scheme://user:pass@` in a
  message are replaced by `[redacted]` in every error. Pools are keyed by a hash, never by the URL.
- **Connections:** one pool per distinct connection in the plugin process, closed after 60 s without calls (idle
  connections after 30 s). All pools close when graphrt stops the plugin.

## Errors
| Kind | When |
|------|------|
| `auth_error` | Wrong user or password (1045, 1698) |
| `network_error` | Cannot connect, connect timeout, TLS failure, connection lost. Retryable for reads, never for `execute`. |
| `permission_denied` | A write or DDL in a read-only call (1792), missing privileges (1044, 1142, 1227, ...), `--secure-file-priv` (1290), `execute` from a tool without the opt-in, or `CALL` in an agent `query` |
| `invalid_input` | Bad arguments, syntax errors, several statements, data or constraint errors (SQLSTATE classes 21, 22, 23, 42) |
| `not_found` | Unknown database, table or function; `describe_table` on a missing table |
| `timeout` | `max_execution_time` / `max_statement_time` reached (3024, 1969), or killed by the plugin 5 s past `statement_timeout_ms` |
| `cancelled` | The run was cancelled or the tool deadline passed |
| `rate_limited` | Too many connections (1040, 1203), retryable |
| `setup_required` | No connection configured, or `npm install` not run |
| `api_error` | Anything else the server refused. Deadlocks and lock wait timeouts (1213, 1205) are retryable. |

## Testing
`npm test` at the repository root runs the unit tests with a fake driver. With a disposable database:
```bash
MYSQL_INTEGRATION_URL=mysql://scratch_user:pass@127.0.0.1:3306/scratch node --test test/integration.test.mjs
```
Use a throwaway database and a user with ALL on it only (no global privileges). The tests create `graphrt_it_<random>` tables and a procedure there and drop them again; they never cancel queries (no `KILL`).

## Changelog
### 0.1.0 (unreleased)
- **Breaking:** the `query`, `execute` and `explain` parameter `timeout_ms` is now `statement_timeout_ms`. graphrt takes `timeout_ms` from every workflow node as the node's own run timeout, so the old name never reached the plugin from a node (it limited the whole node instead of the statement); tool calls that passed `timeout_ms` must use `statement_timeout_ms`. A node may still set graphrt's `timeout_ms` alongside it.

## License
Apache-2.0
