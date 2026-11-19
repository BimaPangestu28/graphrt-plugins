# sqlite

**Status:** stable · **ToS risk:** none. Local only; the tests use the real node:sqlite engine and the example read a real file (2026-11-19). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin that runs parameterised SQL on local **SQLite** files
with Node's built-in `node:sqlite` module, so there are no npm dependencies. Files may only come from directories
you allow. Agents get read-only access by default: `query` opens the file read-only, so SQLite itself refuses
writes.

> **Requires Node.js 22.13 or newer.** Unlike the other plugins in this collection, this one depends on Node's
> built-in `node:sqlite`, which works without flags only from Node.js 22.13. The release catalog (`index.json`)
> currently lists `"node": ">=20"` for every plugin, including this one: do not rely on that field here. On an
> older Node.js the plugin starts, but every operation fails with `setup_required`.

## Features
- **`query`:** one parameterised statement (`?`, `?1`, `:name` placeholders filled from `params` in order) on a
  read-only connection. Returns `rows` (objects), `fields` (name and declared type), `row_count` and `truncated`.
- **`execute`:** one INSERT/UPDATE/DELETE/DDL statement, autocommitted. Returns `changes`, `last_insert_rowid` and
  any `RETURNING` rows. `create_if_missing` creates a new database file. Workflow nodes only, unless
  `SQLITE_TOOL_ALLOW_WRITES=1`.
- **`explain`:** `EXPLAIN QUERY PLAN` as an indented tree plus the raw steps; the statement is not run.
- **`list_tables`** and **`describe_table`:** tables and views with their `CREATE` statements, columns (type,
  nullable, default, primary key position), primary key, indexes and foreign keys.
- Every operation is a node `sqlite.<operation>` and an agent tool. The full reference is in
  [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- **Node.js >= 22.13**, where `node:sqlite` works without flags. On older Node.js every operation fails with
  `setup_required`.
- graphrt with plugin support

## Installation
```bash
graphrt plugin install ./sqlite
```
There is nothing to `npm install`.

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `SQLITE_ALLOWED_DIRS` | (required) | Comma-separated directories (absolute or `~/...`) that database files may be opened from, including subdirectories |
| `SQLITE_PATH` | (none) | Default database file, used when a call has no `database` |
| `SQLITE_STATEMENT_TIMEOUT_MS` | `30000` | Default statement timeout (100 to 600000). Nodes may pass any `statement_timeout_ms`; for agent tool calls this value is also the ceiling. |
| `SQLITE_BUSY_TIMEOUT_MS` | `5000` | How long to wait for a lock held by another connection (0 to 60000) |
| `SQLITE_MAX_RESULT_BYTES` | `1000000` | Most JSON bytes of returned rows per call (1000 to 8000000) |
| `SQLITE_TOOL_ALLOW_WRITES` | (off) | `1` lets agents call `execute` |

The plugin is local only: it asks graphrt for no network access and no secrets, and nodes have no `access_token`.
Choose the file per call with `database`.

## Quick Start
```bash
export SQLITE_ALLOWED_DIRS=~/data SQLITE_PATH=~/data/shop.db
graphrt run sqlite/example.yaml --plugins .
```

## Usage
```yaml
- id: create
  type: sqlite.execute
  sql: "CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY, phone TEXT UNIQUE, name TEXT, seen_at TEXT)"
  create_if_missing: true
- id: save
  type: sqlite.execute
  sql: "INSERT INTO leads (phone, name, seen_at) VALUES (?, ?, datetime('now')) ON CONFLICT (phone) DO NOTHING"
  params: ["{{#start.phone#}}", "{{#start.name#}}"]
- id: recent
  type: sqlite.query
  sql: "SELECT phone, name FROM leads WHERE seen_at >= ? ORDER BY seen_at DESC"
  params: ["2026-11-01"]
```
**Values in results:**
- Integers are numbers when they fit in a double exactly (up to 2^53), otherwise strings ("9007199254740993").
- Reals are numbers. SQLite has no date type: dates are whatever text or numbers you stored.
- Blobs are base64, cut to 64 KiB per value (`values_truncated: true` when that happened).
- In `params`, booleans are sent as `1` / `0`, and objects and arrays as JSON text. Strings bind as text, so a
  blob cannot be passed through `params`; use `x'...'` hex literals or `unhex(?)` (SQLite 3.41+) in the SQL instead.
- Foreign key constraints are enforced (node:sqlite turns them on).

## Safety
- **Read-only at the database level:** `query`, `explain`, `list_tables` and `describe_table` open the file with
  SQLite's read-only flag and also set `PRAGMA query_only`. SQLite refuses INSERT/UPDATE/DELETE and DDL
  (`permission_denied`). The SQL is not parsed to decide what is a write.
- **File allowlist:** the path must be absolute and inside `SQLITE_ALLOWED_DIRS`.
  - It is checked as given and again after resolving symlinks (realpath on both sides, with a separator-suffixed
    prefix so `/data/db-evil` never matches `/data/db`).
  - Only regular files are opened: FIFOs, devices, sockets and directories are refused before SQLite sees them.
  - A missing file and a file outside the allowlist get the same `not_found` error.
  - A new file (`create_if_missing`, `execute` only) must be in an allowed directory.
  - The checks run just before opening, so a symlink swapped in between could still be followed; keep the allowed
    directories writable only by you.
- **Other files:** a read-only connection can still `ATTACH` another file, and `VACUUM INTO` writes a new one, so
  both are refused (`permission_denied`) in `query` and `execute`, for nodes and agents. node:sqlite offers no
  authorizer and no `sqlite3_limit`, so two independent checks run on every statement:
  - a token scanner that skips empty statements (`;`), comments, strings and quoted names, then looks at the
    statement's first word (`;;/*x*/ AtTaCh ...` is still ATTACH);
  - a look at the compiled bytecode (`EXPLAIN`), which refuses any program that calls SQLite's internal
    `sqlite_attach` or runs `Vacuum` with an INTO target. A program that cannot be inspected is refused.

  Extensions cannot be loaded.
- **One statement per call:** SQLite would silently ignore everything after the first statement, so text after it
  (other than comments, spaces and `;`) is refused (`invalid_input`). Values only travel in `params`.
- **Agents (tool calls) vs workflows (nodes):** `execute` refuses tool calls with `permission_denied` unless
  `SQLITE_TOOL_ALLOW_WRITES=1`. Workflow nodes you wrote can always call it; a call that is neither a node nor a tool is refused as well.
- **Caps:** at most `max_rows` rows (default 500, at most 5000) and `SQLITE_MAX_RESULT_BYTES` of JSON per call.
  Rows are read one at a time and reading stops at either cap; `truncated` / `truncated_reason` say so.
- **Timeouts and cancel:** node:sqlite cannot interrupt a statement, so every call runs in its own short-lived
  worker process (about 30 ms of overhead). At `statement_timeout_ms`, on cancel or when a tool deadline passes, the worker is
  killed with SIGKILL. An interrupted write is rolled back from SQLite's journal the next time the file is opened;
  the error says the statement may or may not have been applied. The worker's stdout is discarded, so it can never
  disturb the plugin protocol.
- **Locks:** a file locked by another connection is waited for up to `SQLITE_BUSY_TIMEOUT_MS`, then the call fails
  with a retryable `rate_limited` (nothing was applied).

## Errors
| Kind | When |
|------|------|
| `permission_denied` | A write in a read-only call, `ATTACH` / `VACUUM INTO`, or `execute` from a tool without the opt-in |
| `not_found` | The file is missing or outside `SQLITE_ALLOWED_DIRS`, or an unknown table, column or function |
| `invalid_input` | Bad arguments, a relative path, not a regular file, syntax errors, several statements, constraint failures, not a database file |
| `timeout` | `statement_timeout_ms` reached; the worker was killed |
| `cancelled` | The run was cancelled or the tool deadline passed |
| `rate_limited` | The file stayed locked longer than `SQLITE_BUSY_TIMEOUT_MS` (retryable) |
| `setup_required` | `SQLITE_ALLOWED_DIRS` not set, or Node.js older than 22.13 |
| `api_error` | Anything else SQLite refused (I/O errors, corrupt files, disk full) |

## Changelog
### 0.1.0 (unreleased)
- **Breaking:** the `query`, `execute` and `explain` parameter `timeout_ms` is now `statement_timeout_ms`. graphrt takes `timeout_ms` from every workflow node as the node's own run timeout, so the old name never reached the plugin from a node (it limited the whole node instead of the statement); tool calls that passed `timeout_ms` must use `statement_timeout_ms`. A node may still set graphrt's `timeout_ms` alongside it.

## License
Apache-2.0
