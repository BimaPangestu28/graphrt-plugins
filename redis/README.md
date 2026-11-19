# redis

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for **Redis** (and Redis-compatible servers such as
Valkey), built on `ioredis`. It covers strings, hashes, lists, sets, sorted sets, streams, SCAN and publish.
Values are binary-safe, an optional key prefix isolates the plugin's keys, and agent tool calls are read-only
unless you opt in.

## Features
- **Strings and keys:** `get`, `mget`, `set` (EX/PX/NX/XX), `del`, `exists`, `expire`, `ttl`, `incr`, `incrby`.
- **Hashes:** `hget`, `hset`, `hgetall`, `hdel`.
- **Lists:** `lpush`, `rpush`, `lrange`, `llen`.
- **Sets:** `sadd`, `smembers`, `srem`.
- **Sorted sets:** `zadd` (NX/XX, GT/LT, CH) and `zrange` (by rank or by score, reverse, with scores); `zrem`.
- **Keyspace:** `scan` (cursor, MATCH, COUNT, TYPE). KEYS is never sent.
- **Pub/sub:** `publish`.
- **Streams:** `xadd` (MAXLEN ~, NOMKSTREAM), `xrange` (paged, reverse), `xgroup_create`, `xreadgroup` (never
  blocks) and `xack`.
- **Escape hatch:** `command` runs any other command, such as `HINCRBY`, `LPOP`, `ZSCORE` or `GETDEL`, as a
  name plus an argument array. It is for workflow nodes only (never an agent tool) and has a denylist.
- **Binary-safe:** values are read as bytes. With `encoding: "utf8"` (the default), valid UTF-8 comes back as a
  string and anything else as `{"base64": "…"}`. With `encoding: "base64"`, values are sent and returned as base64.
- Every operation except `command` is a node `redis.<operation>` and an agent tool `<operation>`. The full
  reference is in [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20
- graphrt with plugin support
- Redis 6.2 or newer (`expire` conditions need 7.0; tested against 7.2)

## Installation
```bash
cd redis
npm install          # ioredis and its command table (pinned versions)
graphrt plugin install .
```
The plugin runs `node plugin.mjs` from its own directory, so `node_modules/` must sit next to it. Without it,
every operation fails with `setup_required`.

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `REDIS_URL` | (required) | `redis://[user]:password@host:6379/<db>`, or `rediss://` for TLS. A node's `access_token` (from a secret, with `--trust-plugin redis`) overrides it. The password is redacted from every error. |
| `REDIS_KEY_PREFIX` | (none) | Added in front of every key and pub/sub channel, e.g. `shop:`, and stripped from keys returned by `scan` (see [Safety](#safety)) |
| `REDIS_TOOL_ALLOW_WRITES` | (off) | `1` lets **agent tool calls** run the write operations. Workflow nodes can always write. |
| `REDIS_MAX_VALUE_BYTES` | `1048576` | Largest value one write may send, and the most bytes returned per value on reads (max 64 MiB) |
| `REDIS_MAX_RESULT_BYTES` | `4194304` | Most bytes one read returns in total (max 8 MiB) |
| `REDIS_COMMAND_TIMEOUT_MS` | `10000` | Time limit for each command (100 to 60000) |
| `REDIS_IDLE_MINUTES` | `5` | Close the pooled connection after this many idle minutes |

The connect timeout is 10 s. The connection does not retry or queue commands: a dropped connection fails the
commands that were in flight, and the next operation opens a new one.

## Quick Start
```bash
export REDIS_URL="redis://:<password>@127.0.0.1:6379/0" REDIS_KEY_PREFIX="demo:"
graphrt run redis/example.yaml --plugins .
# Home views: 1. Top: [{"member":"budi","score":120},{"member":"sari","score":99}]
```

## Usage
```yaml
- { id: cache, type: redis.set, key: "quote:A-12", value: "{{#price.data.total#}}", ex: 3600 }
- { id: cached, type: redis.get, key: "quote:A-12" }
- { id: profile, type: redis.hset, key: "user:42", fields: { name: Budi, city: Bandung } }
- { id: events, type: redis.xadd, key: orders, fields: { order: A-12, status: paid }, max_length: 10000 }
- { id: work, type: redis.xreadgroup, key: orders, group: workers, consumer: graphrt-1, count: 10 }
- { id: done, type: redis.xack, key: orders, group: workers, ids: ["{{#work.data.entries.0.id#}}"] }
- { id: score, type: redis.command, command: ZSCORE, args: [leaderboard, budi] }
```
- **Paging:**
  - `scan`: pass `next_cursor` back as `cursor`; it is null when the scan is complete. COUNT is a hint, so a
    page can hold more or fewer keys than `count` (the whole page is always returned, so no key is skipped),
    and SCAN may return a key twice.
  - `xrange`: pass `next_cursor` (an exclusive `(id`) back as `start`, or as `end` with `reverse`.
  - `lrange` / `zrange`: at most 1000 items per call. `lrange` returns `next_start` when it stopped early.
- **Large keys:**
  - `get` / `mget` check STRLEN first and read a value above `REDIS_MAX_VALUE_BYTES` with GETRANGE (its first
    bytes, `truncated: true`), so a huge value is never loaded whole. When the values of an `mget` together pass
    `REDIS_MAX_RESULT_BYTES`, the keys that did not fit are listed in `omitted_keys`.
  - `hget` checks HSTRLEN first. A field above `REDIS_MAX_VALUE_BYTES` is not read (hash fields cannot be read
    partially): `value` is null with `exists: true`, `truncated: true` and its `size`.
  - Every fetch is bounded by count before it is loaded. `hgetall` reads with HSCAN (at most 1000 fields).
    `smembers` returns 1000 arbitrary members (SRANDMEMBER) of a bigger set. `lrange` and `zrange` clamp
    their range to 1000 items. Partial reads say `truncated: true` and give the `total`.
  - Single elements of lists, sets and sorted sets cannot be size-checked before reading, so they count
    against `REDIS_MAX_RESULT_BYTES` only after they arrive.
- **Binary key and field names:**
  - Keys that are not UTF-8 are listed by `scan` as `{"base64": "…"}`. Hash field names that are not UTF-8
    appear in `hgetall` as `"base64:<…>"` keys.
  - Every `key`, `keys` entry and hash field name also accepts both forms, so listed names can be read and
    deleted.
  - The `"base64:<…>"` string only counts as binary when it decodes to bytes that are not valid UTF-8,
    exactly the names the plugin prints that way. An ordinary key such as `base64:aGk=` stays an ordinary key.
- **Consumer groups:** `xreadgroup` never sends NOACK. With `no_ack: true` it reads the entries and then
  acknowledges the ones it returns. When `REDIS_MAX_RESULT_BYTES` cuts the reply, the entries left out stay
  pending for the consumer. Their ids are in `pending_ids`, with a `hint` to read them again with `id: "0"`.
  Nothing is lost.

## Safety
- **Agents (tool calls) vs workflows (nodes):**
  - **Read-only by default.** Agent tool calls to the write operations are refused (`permission_denied`) unless
    `REDIS_TOOL_ALLOW_WRITES=1`. The write operations are `set`, `del`, `expire`, `incr`, `incrby`, `hset`,
    `hdel`, `lpush`, `rpush`, `sadd`, `srem`, `zadd`, `zrem`, `publish`, `xadd`, `xgroup_create`, `xack`, and
    `xreadgroup` (it changes the group's pending list).
  - **No escape hatch.** `command` is node only, so an LLM can never call it.
- **`command` denylist (nodes too):**
  - Wiping, persisting or reconfiguring the server: FLUSHALL, FLUSHDB, CONFIG, SHUTDOWN, DEBUG, SAVE, BGSAVE,
    MODULE, ACL, REPLICAOF, CLUSTER, MIGRATE, RESTORE, SWAPDB…
  - Scripts and functions: SCRIPT, EVAL, EVALSHA, FUNCTION, FCALL.
  - Connection state of the shared connection: SELECT, MOVE, AUTH, HELLO, CLIENT, MULTI/EXEC, WATCH, SUBSCRIBE,
    MONITOR, QUIT…
  - Blocking: BLPOP and friends, WAIT, and XREAD/XREADGROUP with BLOCK.
  - KEYS.
- **Key prefix:**
  - Every key argument of the dedicated operations, and the `publish` channel, gets `REDIS_KEY_PREFIX`.
  - `scan` matches only inside the prefix (the prefix is glob-escaped) and strips it from the keys it returns.
  - With a prefix, `command` finds key positions with the ioredis command table (including SORT BY/GET
    patterns) and prefixes them.
  - It refuses commands the table does not know.
  - It refuses commands that reach outside the prefix: SCAN, RANDOMKEY, DBSIZE, PUBLISH, PUBSUB, SLOWLOG
    (other clients' commands and keys), INFO (key counts of every database), LATENCY, and COPY with DB.
  - Without a prefix these are allowed for nodes.
  - The prefix is isolation within one database, not a security boundary against someone with the same
    credentials. For hard separation use separate databases or ACL users with key patterns (`~shop:*`).
- **No string building:** commands are argument arrays handed to the RESP encoder. Stream ids, score bounds,
  group names and SCAN cursors are validated, so an argument cannot inject extra options.
- **Limits:** value and result byte caps, at most 100 keys or 1000 items per call, a per-command timeout, and
  no blocking reads.
- **Cancellation:** a cancelled run (or the tool deadline) returns `cancelled` at once. Redis cannot recall a
  command, so a cancelled write says it "may already have been applied". Writes are never retried.
- **Secrets:** the URL's password (as written and percent-decoded, in the userinfo or a `password=` query
  parameter) and any `user:password@` userinfo or `password=` parameter are redacted from every error. Outputs never include the URL.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments, a value above the cap, WRONGTYPE, or another `ERR` reply from the server |
| `permission_denied` | A tool-call limit, a denied `command`, or NOPERM (ACL) |
| `auth_error` | No URL, or WRONGPASS / NOAUTH |
| `network_error` | Connection refused, reset or closed (retryable) |
| `timeout` | A command exceeded `REDIS_COMMAND_TIMEOUT_MS` (retryable) |
| `conflict` | BUSYGROUP (the consumer group exists) |
| `not_found` | NOGROUP |
| `setup_required` | ioredis is not installed |
| `cancelled` | The run was cancelled or the tool deadline passed |
| `database_error` | Other server errors (LOADING, BUSY and TRYAGAIN are retryable) |

## Limitations
- No subscribing: pub/sub needs a dedicated connection and a long-running listener, which a request/response
  operation cannot hold.
- Redis Cluster and Sentinel are not supported, only a single endpoint (`MOVED` and `ASK` replies are errors).
- `set` cannot store an empty string: graphrt treats an empty value as missing.
- `exists` sends one EXISTS per key (on one connection), so it reports which keys exist rather than a combined
  count.

## Development
```bash
npm test                                                    # fake ioredis only: no server, no npm install needed
REDIS_INTEGRATION=1 node --test test/integration.test.mjs   # needs `redis-server` on PATH and `npm install`
```
The integration test starts its own `redis-server` on a free 127.0.0.1 port with a password, a temporary
directory and persistence off. It runs real reads and writes (binary values, partial reads, prefixes, scan
paging, streams with consumer groups, the escape hatch, a wrong password), then stops the server and deletes
the directory. It also checks a clean, redacted `network_error` against an unused port.

## License
Apache-2.0
