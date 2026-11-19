# postgres

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin that runs parameterised SQL on **PostgreSQL** with the
[`pg`](https://node-postgres.com) driver. Agents get read-only access by default: `query` runs inside a `READ ONLY`
transaction that is always rolled back, so the database itself refuses writes.

## Features
- **`query`:** one parameterised statement (`$1`, `$2`, ...) in a read-only transaction. Returns `rows` (objects),
  `fields` (name and type), `row_count` and `truncated`.
- **`execute`:** one INSERT/UPDATE/DELETE/DDL statement, committed. Returns `command`, `affected_rows` and any
  `RETURNING` rows. Workflow nodes only, unless `POSTGRES_TOOL_ALLOW_WRITES=1`.
- **`explain`:** `EXPLAIN` (text or JSON, optionally `ANALYZE`) in a read-only transaction.
- **`list_tables`** and **`describe_table`:** tables and views, columns (type, nullable, default, comment), primary
  key, indexes and foreign keys.
- Every operation is a node `postgres.<operation>` and an agent tool. The full reference is in
  [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20
- graphrt with plugin support
- A PostgreSQL server (any supported version) and a login role. Give agents a role with only the privileges they
  need (see Safety).

## Installation
```bash
cd postgres
npm install          # pg and pg-cursor (pinned versions)
graphrt plugin install .
```
Without `node_modules/`, every operation fails with `setup_required`.

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `POSTGRES_URL` | (none) | Connection URL, e.g. `postgres://app:secret@db.example.com:5432/shop?sslmode=verify-full`. Percent-encode special characters in the password. |
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE` | port `5432` | Used when `POSTGRES_URL` is unset. `POSTGRES_HOST` may also be a Unix socket directory. |
| `POSTGRES_SSLMODE` | `disable` | With the separate parts: `disable`, `require` (TLS without certificate checks) or `verify-full`. With a URL, put `sslmode` in the URL. |
| `POSTGRES_STATEMENT_TIMEOUT_MS` | `30000` | Default statement timeout (100 to 600000). Nodes may pass any `statement_timeout_ms`; for agent tool calls this value is also the ceiling. |
| `POSTGRES_CONNECT_TIMEOUT_MS` | `10000` | Connect timeout |
| `POSTGRES_MAX_RESULT_BYTES` | `1000000` | Most JSON bytes of returned rows per call (1000 to 8000000) |
| `POSTGRES_POOL_MAX` | `4` | Connections per pool |
| `POSTGRES_TOOL_ALLOW_WRITES` | (off) | `1` lets agents call `execute`. Leave it off unless the role itself is limited. |
| `POSTGRES_ALLOW_SUPERUSER` | (off) | `1` lets agent tool calls run on a superuser connection (refused by default, see Safety) |

**Per-node connection:** a node's `access_token` replaces the connection for that node. Pass a full `postgres://`
URL from a workflow env variable of type `secret` (`env: [{ name: REPORTING_DB_URL, type: secret }]`, then
`access_token: "{{#env.REPORTING_DB_URL#}}"`) and trust the plugin (`--trust-plugin postgres`) so it arrives
unmasked. Tool calls can never choose a connection.

## Quick Start
```bash
export POSTGRES_URL=postgres://app:secret@127.0.0.1:5432/shop
graphrt run postgres/example.yaml --plugins .
```

## Usage
```yaml
- id: orders
  type: postgres.query
  sql: "SELECT id, total, created_at FROM orders WHERE customer_id = $1 AND created_at >= $2 ORDER BY created_at DESC"
  params: ["{{#start.customer_id#}}", "2026-11-01"]
  max_rows: 50
- id: mark
  type: postgres.execute
  sql: "UPDATE orders SET status = $1 WHERE id = $2 RETURNING id, status"
  params: ["shipped", "{{#orders.data.rows.0.id#}}"]
```
**Values in results:**
- `int8` and `numeric` are strings, so they stay exact.
- `timestamptz` is ISO text with the server's offset and full precision (`2026-11-19T10:00:00.123456+07:00`).
  `timestamp` is ISO text without an offset. `date`, `time` and `timetz` are returned as PostgreSQL writes them.
- `json`/`jsonb` are JSON values, arrays are arrays, `interval` is ISO 8601 (`P0Y0M1DT2H0M0S`).
- `bytea` is base64, cut to 64 KiB per value (`values_truncated: true` when that happened).
- Two columns with the same name come back as `id`, `id_2`.

## Safety
- **Read-only at the database level:** `query`, `explain`, `list_tables` and `describe_table` run inside
  `BEGIN READ ONLY` with a transaction-local `statement_timeout`, and the transaction is rolled back. The SQL is
  never parsed or rewritten to decide whether it is safe: PostgreSQL refuses INSERT/UPDATE/DELETE, DDL, `nextval()`
  and data-modifying CTEs in a read-only transaction (`permission_denied`).
- **Superuser connections:** read-only transactions do not limit superuser-only functions (`pg_terminate_backend`
  on others, `COPY ... TO PROGRAM`, `pg_read_file`, `dblink`). So every agent tool call first checks
  `is_superuser` and is refused (`permission_denied`) on a superuser connection unless
  `POSTGRES_ALLOW_SUPERUSER=1`. Workflow nodes still run, with a warning on stderr. Give agents a role with only
  `SELECT` on the tables they need.
- **Session hygiene:** a pooled connection is reused only after a call succeeded and its session was reset with
  `DISCARD ALL` (session settings, `SET ROLE`, prepared statements, advisory locks, `LISTEN`). After any error,
  an interruption, a failed reset or an `in_transaction: false` write, the connection is destroyed instead, which
  also ends whatever it had open. A connection that dies during a call is logged, never a crash.
- **One statement per call:** every statement goes over the extended protocol, which refuses
  `SELECT 1; DROP TABLE x` (`invalid_input`). Values only travel in `params`.
- **Agents (tool calls) vs workflows (nodes):** `execute` refuses tool calls with `permission_denied` unless
  `POSTGRES_TOOL_ALLOW_WRITES=1`. Workflow nodes you wrote can always call it; a call that is neither a node nor a
  tool is refused as well.
- **Caps and memory:** at most `max_rows` rows (default 500, at most 5000) and `POSTGRES_MAX_RESULT_BYTES` of JSON per
  call; `truncated` / `truncated_reason` (`max_rows` or `max_bytes`) say when a cap stopped the read. Rows come
  through a cursor: the first batch is one row, later batches are sized from the observed row size, so a result of
  huge rows never sits in memory at once. The bytes arriving on the socket are counted too: past 4 x
  `POSTGRES_MAX_RESULT_BYTES` + 1 MiB (for example one enormous value) the socket is closed, the connection discarded,
  and the rows collected so far are returned with `truncated_reason: "max_bytes"`.
- **Timeouts and cancel:**
  - The server-side `statement_timeout` ends long statements (`timeout`). For agent tool calls,
    `POSTGRES_STATEMENT_TIMEOUT_MS` is a ceiling that `statement_timeout_ms` can only lower.
  - `client_connection_check_interval` (PostgreSQL 14+; skipped on older servers) is set to 2 s, so a backend
    notices a vanished client.
  - If the server does not answer 5 s past the timeout, or the run is cancelled or a tool deadline passes, the plugin
    sends `pg_cancel_backend` on a separate connection. A backend that ignores it (e.g. a `DO` loop that catches
    `query_canceled`) gets `pg_terminate_backend` 3 s later, and the call fails then either way.
  - An interrupted read is always reported as `cancelled` or `timeout`, never as a result.
- **No retries for writes:** `execute` never retries. Inside its transaction (`in_transaction: true`, the default)
  a failed statement is rolled back. If the connection is lost or the call is cancelled, the error says the
  statement may or may not have been applied: check before running it again. Use `in_transaction: false` only
  for statements that cannot run in a transaction (`VACUUM`, `CREATE INDEX CONCURRENTLY`).
- **Secrets:** the password (as typed and percent-encoded), the whole connection URL and any `scheme://user:pass@`
  in a message are replaced by `[redacted]` in every error. Pools are keyed by a hash, never by the URL.
- **Connections:** one pool per distinct connection in the plugin process, closed after 60 s without calls (idle
  clients after 30 s). All pools close when graphrt stops the plugin.

## Errors
| Kind | When |
|------|------|
| `auth_error` | Wrong user or password (`28P01`, `28000`) |
| `network_error` | Cannot connect, connect timeout, TLS failure, connection lost. Retryable for reads, never for `execute`. |
| `permission_denied` | A write in a read-only call (`25006`), missing privileges (`42501`), `execute` from a tool without the opt-in, or a tool call on a superuser connection |
| `invalid_input` | Bad arguments, syntax errors, several statements, data or constraint errors (SQLSTATE classes 22, 23, 42, ...) |
| `not_found` | Unknown database, table, function or schema; `describe_table` on a missing table |
| `timeout` | `statement_timeout` reached (`57014`), or no answer 5 s past it |
| `cancelled` | The run was cancelled or the tool deadline passed |
| `rate_limited` | Too many connections (`53300`), retryable |
| `setup_required` | No connection configured, or `npm install` not run |
| `api_error` | Anything else the server refused. Serialization failures and deadlocks (`40001`, `40P01`) are retryable. |

## Testing
`npm test` at the repository root runs the unit tests with a fake driver. With a disposable database:
```bash
POSTGRES_INTEGRATION_URL=postgres://admin:pass@127.0.0.1:5432/scratch node --test test/integration.test.mjs
```
The URL must be a superuser on a throwaway database: the tests create a `graphrt_it_<random>` table and two
`graphrt_it_*` roles, terminate those roles' backends and drop everything again.

## Changelog
### 0.1.0 (unreleased)
- **Breaking:** the `query`, `execute` and `explain` parameter `timeout_ms` is now `statement_timeout_ms`. graphrt takes `timeout_ms` from every workflow node as the node's own run timeout, so the old name never reached the plugin from a node (it limited the whole node instead of the statement); tool calls that passed `timeout_ms` must use `statement_timeout_ms`. A node may still set graphrt's `timeout_ms` alongside it.

## License
Apache-2.0
