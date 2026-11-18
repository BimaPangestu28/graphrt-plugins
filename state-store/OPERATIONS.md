# state-store operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `state-store.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `filter_unseen` | Return the ids not seen before in this namespace (`new_ids`, in input order). With mark=true (default) every given id is marked seen in the same atomic step, so a later or overlapping run never gets them again. For at-least-once processing use mark=false, then mark_seen after the items were handled. | **namespace**, **ids**, mark, ttl_days |
| `mark_seen` | Mark ids seen in this namespace. Ids already seen get a fresh expiry. When the namespace holds over 100000 ids the least recently seen are dropped (`dropped_count`). | **namespace**, **ids**, ttl_days |
| `is_seen` | Check whether one id is seen (and not expired) in this namespace, with when it was first seen and when it expires. | **namespace**, **item_id** |
| `forget_seen` | Remove ids from the seen set, so filter_unseen reports them as new again. | **namespace**, **ids** |
| `get` | Read a key's JSON value. Returns found=false (value null) when the key is missing or expired. | **namespace**, **key** |
| `set` | Store a JSON value (object, array, string, number, boolean or null; at most 1 MB) under a key, replacing any old value. Optional ttl_seconds. | **namespace**, **key**, **value**, ttl_seconds |
| `delete` | Delete a key. Returns deleted=false when it did not exist (or had expired). | **namespace**, **key** |
| `list_keys` | List keys (sorted, optionally only those starting with `prefix`) with their update and expiry times. Values are not included; use get. | **namespace**, prefix, limit, cursor |
| `increment` | Atomically add `by` (default 1, may be negative) to an integer value and return the new value. A missing or expired key starts at 0; ttl_seconds applies only when the counter is created, so a counter with a TTL counts within a fixed window. | **namespace**, **key**, by, ttl_seconds |
| `list_namespaces` | List the namespaces in the store (sorted) with their file size and last modification time. | limit, cursor |
| `clear_namespace` | Delete a namespace's file: all its seen ids and keys. Workflow node only (never an agent tool). | **namespace** |
