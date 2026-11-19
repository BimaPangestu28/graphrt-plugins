# mongodb

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for **MongoDB**, built on the official `mongodb`
driver. It queries and aggregates collections, lists databases and collections, and inserts, updates, replaces
and deletes documents. Values cross the plugin boundary as Extended JSON (relaxed), so ObjectIds, dates and
decimals survive the trip both ways.

## Features
- **Reading:** `find` (filter, projection, sort, `limit` up to 1000, `skip` or `cursor` paging), `find_one`,
  `count`, `distinct` and `aggregate`.
- **Discovery:** `list_databases` and `list_collections`.
- **Writing:** `insert_one`, `insert_many` (up to 1000), `update_one`, `update_many`, `replace_one`, `delete_one`
  and `delete_many`.
- **Extended JSON:** filters and documents may use `{"$oid": "…"}`, `{"$date": "2026-11-19T00:00:00Z"}`,
  `{"$numberDecimal": "10.50"}`, `{"$numberLong": "…"}` and the other EJSON types. Results come back the same way.
- **Bounded work:** queries, aggregations and writes have a server-side `max_time_ms` (default 15 s, max 60 s). Results are capped at
  1000 documents and `MONGODB_MAX_RESULT_BYTES`, and `truncated` / `has_more` say when a cap was hit.
- **Agent-safe by default:** agent tool calls are read-only unless you opt in, may only use allowlisted
  operators (never server-side JavaScript) and only the databases you allow (see [Safety](#safety)).
- Every operation is a node `mongodb.<operation>` and an agent tool `<operation>`. The full reference is in
  [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20.19 (required by driver 7.x)
- graphrt with plugin support
- A MongoDB server (4.2 or newer; tested against 8.0) or Atlas cluster

## Installation
```bash
cd mongodb
npm install          # the mongodb driver (pinned version)
graphrt plugin install .
```
The plugin runs `node plugin.mjs` from its own directory, so `node_modules/` must sit next to it. Without it,
every operation fails with `setup_required`.

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `MONGODB_URL` | (required) | Connection string, `mongodb://user:password@host:27017/shop?authSource=admin` or `mongodb+srv://…`. A node's `access_token` (from a secret, with `--trust-plugin mongodb`) overrides it. The password is redacted from every error and log line. |
| `MONGODB_DATABASE` | database in the URL path | Default database when an operation has no `database` |
| `MONGODB_TOOL_ALLOW_WRITES` | (off) | `1` lets **agent tool calls** run the write operations and `$merge` pipelines. Workflow nodes can always write. |
| `MONGODB_TOOL_ALLOWED_DATABASES` | (none) | Databases **agent tool calls** may use besides the default one, comma-separated (e.g. `crm,reports`), or `*` for any database except `admin`, `local` and `config`. Workflow nodes may use any database. |
| `MONGODB_MAX_RESULT_BYTES` | `1000000` | Extended JSON bytes one read may return (max 8000000) |
| `MONGODB_IDLE_MINUTES` | `5` | Close the pooled connection after this many idle minutes |

Connection timeouts are fixed: server selection 10 s, connect 10 s, socket 90 s. The pool holds at most 5
connections per connection string.

## Quick Start
```bash
export MONGODB_URL="mongodb://app:<password>@127.0.0.1:27017/shop"
graphrt run mongodb/example.yaml --plugins .
# 2 paid orders; newest: [{"number":"A-3","total":{"$numberDecimal":"75000.50"},"created":{"$date":"2026-11-19T09:00:00Z"}}, ...]
```

## Usage
```yaml
- id: recent
  type: mongodb.find
  collection: orders
  filter: { status: paid, created: { $gte: { $date: "2026-11-01T00:00:00Z" } } }
  projection: { _id: 1, number: 1, total: 1 }
  sort: { created: -1 }
  limit: 50
- id: by_city
  type: mongodb.aggregate
  collection: orders
  pipeline:
    - { $match: { status: paid } }
    - { $group: { _id: "$city", total: { $sum: "$total" }, orders: { $sum: 1 } } }
    - { $sort: { total: -1 } }
- id: mark_shipped
  type: mongodb.update_one
  collection: orders
  filter: { number: "{{#recent.data.documents.0.number#}}" }
  update: { $set: { status: shipped, shipped_at: { $date: "2026-11-19T10:00:00Z" } } }
```
- **Paging:** pass `next_cursor` back as `cursor`. It is an offset, so use a stable `sort` (for example on
  `_id`) when paging.
- **Outputs:**
  - `find` / `aggregate`: `documents`, `count`, `truncated` (byte cap hit) and `has_more`.
  - `find_one`: `document` (or null) and `found`.
  - `count`: `count`. `distinct`: `values`, `total_distinct` and `truncated`.
  - Writes: `inserted_id(s)`, `matched_count` / `modified_count` / `upserted_id`, or `deleted_count`.
- **Templates:** a filter or document may also arrive as a JSON string (for example from an upstream node);
  it is parsed as JSON before decoding.

## Safety
- **Agents (tool calls) vs workflows (nodes):** an agent can be steered by the data it reads, so tool calls are
  limited. Workflow nodes (a YAML file you wrote) are not, except for the `$_` rule below.
  - **Read-only by default.** The seven write operations and `$merge` pipelines are refused
    (`permission_denied`) unless `MONGODB_TOOL_ALLOW_WRITES=1`. `$out` (it replaces a whole collection) is
    always refused for tool calls.
  - **Operator allowlist.** Every `$` key a tool call sends (in a filter, projection, sort, document, update or
    pipeline) must be a known aggregation stage, query, projection, update, expression, accumulator or window
    operator, or an Extended JSON type wrapper (the list is in `lib/operator-allowlist.mjs`). Anything else is
    refused, so new or undocumented operators are refused too. Server-side JavaScript (`$where`, `$function`,
    `$accumulator`, `$code`) is not on the list. Neither are administrative stages such as `$currentOp`,
    `$collStats`, `$indexStats` and `$planCacheStats`, or Atlas-only stages such as `$search`.
  - **Databases.** Tool calls may only use the default database (from `MONGODB_DATABASE` or the URL) and those
    in `MONGODB_TOOL_ALLOWED_DATABASES`. `admin`, `local` and `config` are refused in any letter case, and so
    are `system.*` collections. The same rules apply to `$lookup`, `$graphLookup` and `$unionWith` sources and
    to `$merge` targets. `list_databases` shows tool calls only the databases they may use.
- **MongoDB internals:** keys starting with `$_` (such as `$_internalJsEmit`, which runs JavaScript) are refused
  for every caller, nodes included.
- **Mass changes (accident protection):** `update_many` and `delete_many` refuse a filter that obviously
  matches every document unless a node sets `allow_all: true`; tool calls are always refused. The check covers
  `{}`, `{$and: []}`, `{$and: [{}]}`, `{$or: [..., {}]}`, `{$expr: true}` and combinations. It is not a security
  boundary: a filter such as `{"_id": {"$exists": true}}` still matches everything, so give agents a MongoDB user
  whose roles fit what they may do.
- **No string building:** filters, updates and pipelines are passed to the driver as BSON documents, never
  interpolated into a query string. Database and collection names are validated.
- **Limits:** `max_time_ms` on every operation except the two list operations; result caps by documents and bytes; inputs
  larger than 4 MB or nested deeper than 64 levels are refused.
- **Cancellation:** cancelling a run (or hitting the tool deadline) aborts the operation in the driver. Writes cannot
  be called back, so a cancelled write reports `cancelled` with "the write may already have been applied".
  Writes are never retried by the plugin.
- **Secrets:** the connection string's password (as written and percent-decoded) and any `user:password@`
  userinfo are redacted from every error. Outputs never include the connection string.
- **Least privilege:** give the plugin a MongoDB user with only the roles it needs, for example `read` on one
  database for agents that only look things up.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments, invalid names or Extended JSON, a server parse/validation error, a document larger than the byte cap |
| `permission_denied` | A tool-call limit above, a `$_` internal operator, or the MongoDB user lacks the privilege (code 13) |
| `auth_error` | No connection string, or authentication failed |
| `network_error` | No server reachable within 10 s, connection refused or reset (retryable) |
| `timeout` | `max_time_ms` exceeded (retryable) |
| `conflict` | Duplicate key |
| `setup_required` | The `mongodb` package is not installed |
| `cancelled` | The run was cancelled or the tool deadline passed |
| `database_error` | Any other server error |

## Limitations
- Agent tool calls cannot use operators missing from the allowlist (new server versions may add some); use a
  workflow node for those.
- Update pipelines (an array as `update`), transactions, change streams, indexes, GridFS and `mapReduce` are not
  offered. Use `aggregate` with `$merge` from a node for pipeline-style bulk updates.
- `count` uses `countDocuments`, which scans matching documents; on very large collections give it a selective
  filter or a larger `max_time_ms`.
- `distinct` returns at most 1000 values; the server limits its reply to 16 MB.
- Connection options in the URL (for example `serverSelectionTimeoutMS`) are overridden by the fixed timeouts
  above.

## Development
```bash
npm test                                                      # fake driver only: no server, no npm install needed
MONGODB_INTEGRATION=1 node --test test/integration.test.mjs   # needs `mongod` on PATH and `npm install`
```
The integration test starts its own `mongod` on a free 127.0.0.1 port with a temporary data directory, runs real
reads and writes (EJSON round trips, paging, maxTimeMS, duplicate keys), then stops the server and deletes the
directory. It also checks a clean, redacted `network_error` against an unused port.

## License
Apache-2.0
