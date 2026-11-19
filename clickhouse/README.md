# clickhouse

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for [ClickHouse](https://clickhouse.com) over its
[HTTP interface](https://clickhouse.com/docs/interfaces/http): self-hosted servers and ClickHouse Cloud. Agent
queries run with `readonly=1`, a time limit and result caps; values go in typed query parameters, never into the SQL
text. Metadata reads are declarative ([`definition.mjs`](definition.mjs)); `query`, `insert_rows` and `execute` are
hand-written ([`lib/clickhouse-operations.mjs`](lib/clickhouse-operations.mjs)) because their `param_<name>` URL
entries are named by the caller.

## Features
- **Server and schema:** `ping`, `server_info` (version, uptime, time zone, user), `list_databases`, `list_tables`
  (engine, rows, bytes, sorting key), `describe_table` (columns, types, defaults, key membership)
- **`query`:** one read-only statement (SELECT, SHOW, DESCRIBE, EXPLAIN) with `{name:Type}` placeholders and
  `parameters`, returning ClickHouse's JSON (`meta`, `data`, `rows`, `statistics`)
- **`insert_rows`:** rows as JSON objects into a table (`INSERT INTO <db>.<table> FORMAT JSONEachRow`, names
  backtick-quoted), returning `written_rows`
- **`execute`** (node only): any statement: `INSERT ... SELECT`, `CREATE`, `ALTER`, mutations, `DROP`, `TRUNCATE`

Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A ClickHouse server with the HTTP interface (port 8123, or 8443 with TLS; ClickHouse Cloud: 8443)

## Installation
```bash
graphrt plugin install ./clickhouse
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `CLICKHOUSE_URL` | no | Server URL, default `http://localhost:8123`. https required except on localhost, e.g. `https://abc123.eu-west-1.aws.clickhouse.cloud:8443`. A path prefix (reverse proxy) is kept; no query or credentials in the URL. |
| `CLICKHOUSE_USER` | no | User, default `default` (sent as `X-ClickHouse-User`) |
| `CLICKHOUSE_PASSWORD` | no | Password (sent as `X-ClickHouse-Key`, never in the URL); empty for a passwordless local user |
| `CLICKHOUSE_TOOL_ALLOW_WRITES` | no | `1` lets agent tools call `insert_rows` |

**Getting credentials:** ClickHouse Cloud console → your service → Connect → HTTPS shows the URL and the `default`
user's password. Better: create a dedicated user with only the grants a workflow needs, e.g.
`CREATE USER agent IDENTIFIED BY '...' SETTINGS readonly = 1; GRANT SELECT ON analytics.* TO agent;`.

A node may pass `access_token` to use another password for that node; agent tools never can.

**Pricing:** ClickHouse Cloud bills compute (per minute a service is awake) and storage, not per request; a heavy
query wakes an idle service and uses compute. `query` caps each call at `max_execution_time` (default 30 s, at most
120 s) and the result at 10,000 rows and 10 MB by default.

## Quick Start
```bash
CLICKHOUSE_URL=https://play.clickhouse.com CLICKHOUSE_USER=play graphrt run clickhouse/example.yaml --plugins .
```
ClickHouse's public playground (user `play`, no password, read-only) answers the example: server version, databases,
and tables per database.

## Usage
```yaml
- id: signups
  type: clickhouse.query
  sql: "SELECT toDate(ts) AS day, count() AS signups FROM analytics.events WHERE event = {event:String} AND ts >= {since:DateTime} GROUP BY day ORDER BY day"
  parameters: { event: signup, since: "2026-11-01 00:00:00" }
- id: store
  type: clickhouse.insert_rows
  database: analytics
  table: daily_reports
  rows: [{ day: "2026-11-19", signups: 42 }]
```
Array parameters are lists (`{tags:Array(String)}` with `tags: [a, b]`). Large integers arrive as strings
(ClickHouse's JSON quotes 64-bit integers).

## Agent policy
- **`query` is always read-only.** Every call sends `readonly=1` as the last URL setting, after
  `max_execution_time`, `max_result_rows`, `max_result_bytes`, `result_overflow_mode` and `wait_end_of_query=1`.
  ClickHouse checks all URL settings of a request against the session before applying them (verified in
  `HTTPHandler.cpp`), so the limits apply, and then, under readonly=1:
  - writes, DDL, `SET` and the query's own `SETTINGS` clause are refused (`READONLY`), so a query cannot raise its
    limits or switch readonly off;
  - most table functions (`url`, `s3`, `file`, `remote`, ...) are refused, so a query cannot send data to other
    hosts;
  - the HTTP interface runs one statement per request (no `;`-chained statements).
  Parameter names must be identifiers, so a parameter cannot add URL settings.
- **Users whose profile is already read-only:** a readonly=1 profile refuses any setting change. `query` then reads
  the profile's `readonly` value and, when it is 1, sends the query once more without settings (still read-only).
  The server then applies only the profile's own limits, not `max_execution_time`, `max_result_rows` or
  `max_result_bytes`: the plugin applies the row and byte caps to the parsed result instead (`throw` fails,
  `break` keeps the first rows and sets `result_truncated: true`), and the request timeout still ends the call, but
  the server may read and send more than the caps before that. Give such users their own limits, or
  `changeable_in_readonly` constraints so the caps can be sent. A readonly=2 profile is refused, because it would
  allow `SET` and table functions.
- **Result size for agents:** tools may set `max_result_bytes` up to 10 MB (10485760, the default); nodes up to
  100 MB.
- **`insert_rows` needs `CLICKHOUSE_TOOL_ALLOW_WRITES=1`** for tools. The SQL is generated (quoted names, rows as
  JSONEachRow data), and it runs with `allow_ddl=0`.
- **`execute` is node only.** Arbitrary non-readonly SQL could drop tables or use `INSERT INTO FUNCTION url(...)` to
  send data anywhere, so it is never an agent tool, opt-in or not. DDL and `DROP` therefore stay node only.
- **No `api_request`:** a GET with a `query` parameter would run any SQL at readonly=2, which allows `SET` and table
  functions.
- Tool results are truncated to 100,000 characters; nodes get everything.

## Errors
ClickHouse answers with a text body such as `Code: 60. DB::Exception: Unknown table ... (UNKNOWN_TABLE)`, and the
HTTP status varies by version and proxy, so the exception code decides the kind: authentication failures
(516, 192-194) are `auth_error`, `READONLY` (164) and `ACCESS_DENIED` (497) are `permission_denied`, unknown
tables, databases and columns are `not_found`, syntax and parameter errors are `invalid_input`, `TIMEOUT_EXCEEDED`
is `timeout`, and too many simultaneous queries is `rate_limited`. An exception streamed after a 200 status
(`X-ClickHouse-Exception-Code`) is an error, not data. Failed queries are not repeated by the client (a timeout would
cost the full time again); a failed insert says how to check before inserting again.

## License
Apache-2.0
