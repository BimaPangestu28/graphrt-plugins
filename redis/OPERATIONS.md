# redis operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `redis.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get` | Read a string value. Returns null when the key does not exist; values above REDIS_MAX_VALUE_BYTES come back cut, with `truncated: true`. | **key**, encoding |
| `mget` | Read up to 100 string values. Keys that do not exist or hold another type give null. When the values together pass REDIS_MAX_RESULT_BYTES, the rest are listed in `omitted_keys`. | **keys**, encoding |
| `set` | Write a string value, optionally with an expiry (`ex` seconds or `px` milliseconds) and only if it does not exist (`nx`) or already exists (`xx`). Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **key**, **value**, encoding, ex, px, nx, xx |
| `del` | Delete up to 100 keys. Returns how many existed. Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **keys** |
| `exists` | Check up to 100 keys: returns which exist and how many. | **keys** |
| `expire` | Set a key's time to live in seconds (optionally only when it has none (NX), has one (XX), or the new one is greater (GT) or less (LT)). Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **key**, **seconds**, condition |
| `ttl` | Read a key's remaining time to live in seconds (`exists: false` when the key is missing, `persistent: true` when it has no expiry). | **key** |
| `incr` | Add 1 to an integer value (a missing key counts as 0). Returns the new value. Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **key** |
| `incrby` | Add an integer (negative to subtract) to an integer value (a missing key counts as 0). Returns the new value. Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **key**, **increment** |
| `hget` | Read one field of a hash. Returns null when the key or field does not exist. A field above REDIS_MAX_VALUE_BYTES is not read: value null, `truncated: true` and its `size`. | **key**, **field**, encoding |
| `hset` | Set one or more fields of a hash, e.g. {"name": "Budi", "city": "Bandung"}. Returns how many fields were new. Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **key**, **fields**, encoding |
| `hgetall` | Read a hash as an object (at most 1000 fields, read with HSCAN; larger hashes come back partially with `truncated: true`). Field names that are not UTF-8 appear as "base64:<…>". | **key**, encoding |
| `hdel` | Delete fields from a hash. Returns how many existed. Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **key**, **fields** |
| `lpush` | Insert values at the head of a list (the last value ends up first). Returns the new length. At most 1000 values per call. Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **key**, **values**, encoding |
| `rpush` | Append values to the tail of a list. Returns the new length. At most 1000 values per call. Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **key**, **values**, encoding |
| `lrange` | Read list items from `start` to `stop` (inclusive, negative from the end); at most 1000 items, with next_cursor for the rest. | **key**, start, stop, encoding |
| `llen` | Number of items in a list (0 when the key does not exist). | **key** |
| `sadd` | Add members to a set. Returns how many were new. Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **key**, **members**, encoding |
| `smembers` | List a set's members (at most 1000; of a larger set, 1000 arbitrary members with `truncated: true`). | **key**, encoding |
| `srem` | Remove members from a set. Returns how many were there. Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **key**, **members**, encoding |
| `zadd` | Add members with scores to a sorted set, e.g. [{"member": "budi", "score": 120}]. Returns how many were new (or changed, with `changed: true`). Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **key**, **members**, condition, comparison, changed, encoding |
| `zrange` | Read sorted-set members by rank (`start`/`stop`) or, with `by_score`, by score (`min`/`max`, e.g. "(10" or "+inf"); lowest first unless `reverse`. At most 1000 members. | **key**, start, stop, by_score, min, max, reverse, with_scores, encoding |
| `zrem` | Remove members from a sorted set. Returns how many were there. Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **key**, **members**, encoding |
| `scan` | List keys in pages with SCAN (never KEYS): pass `match` (glob, e.g. "cart:*"), `count` as a hint and the returned next_cursor to continue. Keys are returned without REDIS_KEY_PREFIX. | cursor, match, count, key_type, encoding |
| `publish` | Publish a message on a pub/sub channel (REDIS_KEY_PREFIX is added to the channel). Returns how many subscribers received it. Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **channel**, **message**, encoding |
| `xadd` | Append an entry {field: value} to a stream, optionally trimming it to about `max_length` entries. Returns the new entry id. Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **key**, **fields**, entry_id, max_length, no_create, encoding |
| `xrange` | Read stream entries between `start` and `end` ids ("-" and "+" for the ends), oldest first unless `reverse`. Pass next_cursor back as `start` (or `end` when reversed) for the next page. | **key**, start, end, count, reverse, encoding |
| `xreadgroup` | Read entries for a consumer of a consumer group (never blocks). `id` ">" gets new entries (and records them as pending for this consumer); "0" re-reads this consumer's pending entries. Counts as a write because it changes the group's state. Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **key**, **group**, **consumer**, start_id, count, no_ack, encoding |
| `xgroup_create` | Create a consumer group on a stream, starting at `id` ("$" for only new entries, "0" for the whole stream). Creates the stream when missing unless `create_stream` is false. Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **key**, **group**, start_id, create_stream |
| `xack` | Acknowledge entries a consumer group has processed, so they leave the pending list. Returns how many were pending. Agent tool calls need REDIS_TOOL_ALLOW_WRITES=1. | **key**, **group**, **ids** |
| `command` | Workflow nodes only: run one Redis command given as name + argument array, e.g. {"command": "HINCRBY", "args": ["stats", "views", 1]}. Dangerous, scripting, blocking and connection-state commands are refused. | **command**, args, encoding |
