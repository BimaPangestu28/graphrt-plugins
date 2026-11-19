# file-watcher operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `file-watcher.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `snapshot` | Records the files and directories (type, size, modified time) under a directory inside the allowed directories and returns a cursor for list_changes or wait_for_change | path, max_depth, include_hidden, name_pattern |
| `list_changes` | Rescans the directory of a cursor and lists what was added, modified or removed since it was taken, with a new cursor | **cursor**, max_changes |
| `wait_for_change` | Polls a directory (or a cursor's directory) until something is added, modified or removed, or until timeout_seconds (at most 300) pass; returns the changes and a new cursor either way | path, cursor, timeout_seconds, poll_interval_ms, max_depth, include_hidden, name_pattern, max_changes |
