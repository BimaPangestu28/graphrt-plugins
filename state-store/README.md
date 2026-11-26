# state-store

**Status:** stable · **ToS risk:** none. Local only; the polling example ran live (new ids, then none) in PR #13 and again on 2026-11-19. See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin that gives workflows a small local memory. Its main job
is polling: a workflow that checks new comments, DMs or orders every few minutes calls `filter_unseen` and handles
only the ids it has not seen before. It also stores small JSON values and atomic counters.

State lives in one JSON file per namespace on the local disk. The plugin uses no network and no secrets
(`localOnly`). Every operation is a workflow node and, except `clear_namespace`, an agent tool.

## Features
- **Seen ids:** `filter_unseen` (check and mark in one atomic step), `mark_seen`, `is_seen`, `forget_seen`.
  - Ids expire `ttl_days` (default 90) after they were last marked.
  - A namespace holds at most 100 000 ids; when it is full, the least recently seen ids are dropped first. This
    is intentional: an id that keeps showing up in polls stays known, while ids no feed returns any more go first.
  - Re-marking an id that was marked less than an hour ago (same TTL) changes nothing, so a poll that sees only
    known ids does not rewrite the file. Recency for eviction therefore has a one-hour granularity.
- **Key/value:** `get`, `set` (any JSON value, optional `ttl_seconds`), `delete`, `list_keys` (by prefix, paginated),
  `increment` (atomic counter).
- **Housekeeping:** `list_namespaces`, `clear_namespace` (workflow node only, so an agent cannot wipe seen ids).
- **Safe under concurrency and crashes:** see [Guarantees](#guarantees).

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support. No npm dependencies.
- A local file system (not a network share, see [Limitations](#limitations)).

## Installation
```bash
graphrt plugin install ./state-store
```

## Quick start
```bash
STATE_STORE_DIR=/tmp/state-demo graphrt run state-store/example.yaml --plugins .
```
Run it twice. The first run reports `c-101`, `c-102` and `c-103` as new, the second run reports nothing new.

## Usage
In these snippets `fetch` stands for any upstream node whose output holds a list of id strings (for example a code
node that picks `id` from each comment `meta-api.list_comments` returned). `ids` also accepts a JSON array string.

### Polling, at most once (simplest)
```yaml
- { id: fresh, type: state-store.filter_unseen, namespace: fb-comments, ids: "{{#fetch.data.ids#}}" }
# … handle {{#fresh.data.new_ids#}} …
```
`filter_unseen` returns the new ids and marks them seen in the same locked step. Two overlapping runs never both get
the same id as new. If the workflow crashes after this step, those items are not offered again.

### Polling, at least once
```yaml
- { id: check, type: state-store.filter_unseen, namespace: fb-comments, ids: "{{#fetch.data.ids#}}", mark: false }
# … handle {{#check.data.new_ids#}} …
- { id: done, type: state-store.mark_seen, namespace: fb-comments, ids: "{{#check.data.new_ids#}}" }
```
Items are marked only after they were handled, so a crash means they come back next run. Two overlapping runs may
then both handle an item, so make the handling idempotent or don't run overlapping polls.

### Values and counters
- `set` stores any JSON value up to 1 MB.
- `increment` adds `by` (default 1) atomically. A counter created with `ttl_seconds` keeps that expiry when it is
  incremented, which gives a fixed-window rate counter (e.g. "replies sent this hour").

### Return values
- `filter_unseen` → `{new_ids, new_count, seen_count, marked, dropped_count}`
- `mark_seen` → `{marked_count, new_count, dropped_count}`
- `is_seen` → `{id, seen, seen_at, expires_at}`. The parameter is `item_id`, because `id` is the node id in a workflow.
- `get` → `{key, found, value, updated_at, expires_at}`
- `list_keys` / `list_namespaces` → a page plus `next_cursor` (null on the last page).

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `STATE_STORE_DIR` | no | Absolute directory for the namespace files (default `~/.graphrt/state-store`; a leading `~/` is expanded). Created with mode 0700; files are 0600. |

Namespaces match `^[a-z0-9][a-z0-9_.-]{0,63}$`. Each one is `<namespace>.json` in that directory.

## Guarantees
- **Atomic updates.** Every write is a read-modify-write under two locks: an in-process queue per namespace and a lock
  file (`<namespace>.lock`) shared with other processes. The new content is written to a temp file, fsynced and
  renamed over the old file, and the directory is fsynced. A crash leaves the old file or the new one, never a mix.
  Reads (`get`, `is_seen`, `list_keys`, `filter_unseen` with `mark: false`) take no lock, because they always see a
  whole file.
- **Lock file.** It is created with an exclusive create and holds `{pid, token, hostname, created_at, boot_time}`.
  The owner re-reads it to check its random token, and checks it again just before its rename.
  - A lock is stale when its process is dead, when it was created before the machine's last boot (pids are reused
    after a reboot; the hostname may have changed), or when it cannot be parsed and is older than 30 s.
  - A stale lock is taken over. Only the process that wins a second exclusive file
    (`<namespace>.lock.break-<hash>`) may take it over, and only if the lock is still the very same file (inode,
    mtime, size and content) and still stale. It then renames a fresh lock over it and verifies it. So even when
    several processes notice the same stale lock together, at most one of them ever holds it.
  - After acquiring the lock, a process removes that lock's leftover `break-*` guards and temp files older than 30 s.
  - A process waits up to 10 s for a live holder, then fails with `lock_timeout` (retryable).
  - A failure to remove the lock file after the update is only logged to stderr: the update already happened (or
    failed for its own reason, which is what is reported). The leftover lock is treated as stale.
- **Corrupt files fail closed.** A file that is not valid state fails every operation on that namespace with
  `state_corrupt` and is left untouched. The plugin never resets a namespace on its own, because forgetting seen ids
  would make a polling workflow handle every old item again. Restore the file from a backup or move it aside.
- **Errors leave no change.** Failures before the rename (disk full, lock lost, a size limit) change nothing, and
  retrying is safe. A failed directory fsync after the rename is only logged, because the update already happened.
- **Clock jumps.** Expired ids and keys are purged on the next write. If that write comes over 30 days after the
  file's last write and would purge more than half of the seen ids, the clock probably jumped forward: the purge is
  skipped once and a warning goes to stderr (the next write purges as usual). Expired ids are still reported as
  unseen; skipping only keeps them on disk in case the clock is wrong.

## Limits
| Limit | Value | Over the limit |
|-------|-------|----------------|
| Value size (JSON) | 1 MB | `invalid_input` |
| Namespace file | 50 MB | `invalid_input`, nothing written |
| Seen ids per namespace | 100 000 | least recently seen dropped (`dropped_count`) |
| Ids per call | 10 000 | `invalid_input` |
| Id length | 256 bytes (UTF-8, as stored in JSON) | `invalid_input` (hash longer ids) |
| Key length | 512 chars | `invalid_input` |
| `ttl_days` | 1–3650 (default 90) | `invalid_input` |

## Error kinds
`invalid_input`, `state_corrupt`, `lock_timeout` (retryable), `storage_error` (retryable when nothing was written),
`cancelled`.

## Limitations
- **Local disks only.** Stale locks are detected by pid on the same host and by boot time. A lock that another host
  wrote during this boot is never broken (on a local disk that cannot happen); a lock written before this boot is
  broken whatever its hostname, which would be wrong on a shared network disk.
- **Pid reuse.** If a crashed holder's pid now belongs to an unrelated live process in the same boot, the lock looks
  alive and callers time out. The error names the lock file; delete it if no graphrt run is using the namespace.
  (Pid reuse across a reboot is handled: such a lock is older than the boot.)
- **No null or empty string values.** `set` cannot store `null` or `""`, because the runner treats them as missing.
  Use `delete` instead.
- **Every write rewrites the namespace file.** Keep busy namespaces small: use one namespace per feed, not one
  for everything.

## License
Apache-2.0
