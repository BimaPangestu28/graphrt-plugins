# file-watcher

**Status:** stable · **ToS risk:** none. Local only; detected a real new file live (PR #48). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin that **notices new, changed and removed files** in
directories you allow. graphrt nodes and tools are request/response, so there is no background watcher: the plugin
polls. A snapshot becomes a cursor; later calls rescan and report what changed since that cursor, or wait (up to
five minutes) for the next change.

## Features
- **`snapshot`:** records the entries under a directory (type, size, modified time) and returns a `cursor`.
- **`list_changes`:** rescans the cursor's directory and returns `added`, `modified` and `removed` entries, with
  a new `cursor` to continue from.
- **`wait_for_change`:** polls every `poll_interval_ms` (default 2000, at least 250) until something changes or
  `timeout_seconds` (default 60, at most 300) pass; returns `changed`, the changes and a new `cursor` either way.
  With a `cursor`, changes made since that cursor are returned at once, so nothing is missed between calls.
- **Filters:** `max_depth` (default 5, at most 20), `include_hidden`, `name_pattern` (`*` and `?`, e.g. `*.csv`).

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js 20 or newer. No npm dependencies.

## Installation
```bash
graphrt plugin install ./file-watcher
```

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `FILE_WATCHER_ALLOWED_DIRS` | (required) | Comma-separated directories (absolute or `~/...`) that may be watched, subdirectories included |
| `FILE_WATCHER_MAX_ENTRIES` | `10000` | Most entries one snapshot looks at, counting those `name_pattern` skips (10 to 100000); a bigger tree gives `truncated: true` |

Local only: the plugin asks graphrt for no network access and no secrets.

## Quick Start
```bash
mkdir -p ~/graphrt-inbox
FILE_WATCHER_ALLOWED_DIRS=~/graphrt-inbox graphrt run file-watcher/example.yaml --plugins .
# drop a .csv file into ~/graphrt-inbox within 30 seconds
```

## Usage
A polling workflow stores the cursor between runs (e.g. with the [state-store](../state-store/) plugin) and calls
`list_changes` each time:
```yaml
- { id: changes, type: file-watcher.list_changes, cursor: "{{#saved.data.value#}}" }
```
Result:
```json
{ "added": [{ "path": "orders/2026-11-19.csv", "type": "file", "size_bytes": 1832, "modified_at": "2026-11-19T03:42:34.126Z" }],
  "modified": [], "removed": [], "has_changes": true, "changes_truncated": false,
  "path": "/Users/me/graphrt-inbox", "entry_count": 12, "truncated": false, "unreadable_directories": [],
  "since": "2026-11-19T03:40:00.000Z", "cursor": "fw1...." }
```
Paths in changes are relative to the watched directory.

## Limits and caveats
- **Polling, not events:** a file created and deleted between two scans is never seen. An edit that keeps the
  size and lands within the file system's modification-time resolution can be missed.
- **Cursors are self-contained** (the snapshot, deflated and base64url-encoded behind `fw1.`), so they survive
  plugin restarts but grow with the tree: about 20–40 bytes per entry. Keep `FILE_WATCHER_MAX_ENTRIES` and the
  scope (`max_depth`, `name_pattern`) small for big trees.
- A truncated snapshot (`truncated: true`) can report entries past the cap as added or removed; narrow the scope.

## Safety
- **Allowlist:** the directory is `realpath`'d and must be an allowed directory or inside one (separator-suffixed
  prefix, so `/data/in-evil` is not inside `/data/in`); a path outside gets the same `not_found` as a missing one.
- **Cursors are untrusted input:** decompression is capped at 64 MiB (no zip bombs) and the content is
  shape-checked. The cursor's directory must be absolute and equal to its own real path (no relative paths, no
  symlinks) and inside the allowlist; its options must be within the parameter limits (`max_depth` 1–20, a
  `name_pattern` of at most 256 characters) and its entries within `FILE_WATCHER_MAX_ENTRIES`. Walks use the
  verified real path, never the cursor's text. A forged cursor can therefore do no more than `snapshot` with
  arguments could; cursors are not signed, so they stay valid across plugin restarts.
- **Name patterns** are matched with a linear two-pointer wildcard matcher, not a regular expression, so a
  hostile pattern such as `*a*a*a*a*a*b` cannot stall the plugin.
- **Read-only:** the plugin only lists and `lstat`s entries; it never opens files, never follows symlinks (they are
  recorded as `symlink`) and reports unreadable directories in `unreadable_directories`.
- **Bounded:** depth, entry count, change count (`max_changes`), wait time (300 s, inside the call timeout) and
  cancel (stops the wait at once).
- The directory walker (`lib/directory-walker.mjs`) is a copy of local-files'; keep the copies in step.

## Errors
| Kind | When |
|------|------|
| `setup_required` | `FILE_WATCHER_ALLOWED_DIRS` is unset |
| `not_found` | The directory is missing or outside the allowed directories (also for a cursor's directory) |
| `invalid_input` | Not a directory, a damaged or foreign cursor, neither `path` nor `cursor` for a wait |
| `cancelled` | The call was cancelled or passed the tool deadline |

## License
Apache-2.0
