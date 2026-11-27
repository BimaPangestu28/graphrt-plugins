# local-files

**Status:** stable · **ToS risk:** none. Local only; listed a real directory live and returned a clean not_found (PR #48). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for **files in directories you allow**. Workflows and
agents can list, stat, read and search files there, and write new ones. Nothing outside `LOCAL_FILES_ALLOWED_DIRS`
is reachable, agents are read-only unless you opt in, and even then they can only create new files.

## Features
- **`list_allowed_directories`:** the allowed roots as real paths, and whether each exists.
- **`list_directory`:** name, type, size and modified time, sorted; `max_depth` (1–10) recurses, `limit`
  (default 500, at most 5000) caps the entries and sets `truncated`. Hidden names only with `include_hidden`.
- **`stat`:** type (file, directory, symlink, fifo, socket, device), size, modified/created/accessed times,
  permission bits and hard-link count, without opening the file. Regular files with more than one hard link are
  refused (their metadata could belong to a file outside the allowlist).
- **`read_file`:** UTF-8 text or base64, from `offset`, at most `max_bytes` (default 256 KiB, never more than
  `LOCAL_FILES_MAX_READ_BYTES`). A capped read returns `truncated: true` and `next_offset`; a UTF-8 slice never
  ends in the middle of a character. Bytes that are not valid UTF-8 are refused with a hint to use base64.
- **`search_files`:** by file-name glob (`*`, `?`) and/or a plain-text substring per line (no regular
  expressions, so no ReDoS), case-insensitive by default; bounded by `max_depth`, `max_results`,
  `max_matches_per_file` (default 10; `files_with_more_matches` counts files that had more) and
  `LOCAL_FILES_MAX_SEARCH_FILES` (every entry visited counts, directories included; see `entries_scanned`). Name
  globs use a linear two-pointer matcher, so hostile patterns cannot stall it. Binary, oversized and hard-linked
  files are skipped and counted in `skipped_files`.
- **`write_file`:** UTF-8 or base64 content to a new file, staged and published atomically; `create_parents`
  makes missing directories inside the allowlist. `overwrite: true` (workflow nodes only) replaces an existing
  regular file and keeps its permission bits.
- **`delete_path`** (workflow nodes only): one file, symlink (the link itself) or empty directory.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js 20 or newer. No npm dependencies.

## Installation
```bash
graphrt plugin install ./local-files
```

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `LOCAL_FILES_ALLOWED_DIRS` | (required) | Comma-separated directories (absolute or `~/...`), subdirectories included. Relative paths in calls start at the first one. |
| `LOCAL_FILES_TOOL_ALLOW_WRITES` | (off) | `1` lets **agents** call `write_file` to create new files. Workflow nodes can always write. |
| `LOCAL_FILES_MAX_READ_BYTES` | 1 MiB | Most bytes one `read_file` returns (1024 to 64 MiB); also the largest file `search_files` reads |
| `LOCAL_FILES_MAX_WRITE_BYTES` | 10 MiB | Largest `write_file` content (1024 to 1 GiB) |
| `LOCAL_FILES_MAX_SEARCH_FILES` | 10000 | Most entries (files, directories, symlinks) one `search_files` call visits (10 to 200000) |

The plugin is local only: it asks graphrt for no network access and no secrets.

## Quick Start
```bash
mkdir -p ~/graphrt-files && echo "hello" > ~/graphrt-files/notes.txt
export LOCAL_FILES_ALLOWED_DIRS=~/graphrt-files
graphrt run local-files/example.yaml --plugins .
```

## Usage
```yaml
- { id: save, type: local-files.write_file, path: reports/today.md, content: "{{#llm.text#}}", create_parents: true }
- { id: read, type: local-files.read_file, path: reports/today.md }
```
A read result looks like:
```json
{ "path": "/Users/me/graphrt-files/notes.txt", "size_bytes": 6, "offset": 0, "bytes_read": 6, "next_offset": null, "truncated": false, "encoding": "utf8", "content": "hello\n" }
```
`content` may not be empty (graphrt treats an empty string as a missing value).

## Safety
- **Allowlist:** every path is `realpath`'d and compared with the real allowed directories using a
  separator-suffixed prefix, so `/data/in-evil` is not inside `/data/in`, and `../` or a symlink out is refused. For a
  new file, its parent directory is resolved and checked and the final name is never followed. A path outside the
  allowlist gets the same `not_found` as a missing one, so the plugin is no existence oracle for the rest of the disk.
- **File types:** reads and searches open only regular files, with `O_NOFOLLOW | O_NONBLOCK`, and check the open
  handle again (regular file, one link). `O_NOFOLLOW` covers only the last path component: if the final file is
  swapped for a symlink or FIFO after the checks the open fails instead of escaping or hanging, but a directory
  higher up the path swapped for a symlink in that window is not caught; the allowlist is a guard rail against
  mistakes and agents, not against another local user racing the plugin. FIFOs, sockets and devices are never
  opened (`stat` describes them). Files with more than one hard link are refused for reads, `stat` and overwrites and
  skipped by searches: a hard link inside an allowed directory can point at a file outside it.
- **Walks** never follow symlinks (they are listed as `symlink`), are bounded by depth, entry and file counts, stop
  on cancel, and report unreadable directories in `unreadable_directories` instead of hiding them.
- **Writes are staged:** content goes to a private `.<name>.<random>.partial` file (0600, `O_EXCL`) in the target
  directory and is flushed. A new file is published with `link()`, which never replaces anything; if the name
  appeared meanwhile the write fails and nothing is replaced. An overwrite (nodes only) refuses symlinks, hard-linked
  files, FIFOs, devices and directories, and `rename()`s over the target atomically. Failed writes leave nothing behind.
- **Agents vs nodes:** tool calls are read-only by default. `LOCAL_FILES_TOOL_ALLOW_WRITES=1` lets them create new
  files, never overwrite. `delete_path` is never a tool. An allowed directory itself can never be written or deleted.
- **Error messages** keep the system's reason but replace absolute paths outside the allowlist with `[path]`. Names with spaces are hidden whole: a quoted path up to its closing quote, otherwise up to the word with a file extension (`My File.txt`); a name without an extension takes along the words that start with a capital letter (`C:\Users\Budi Santoso`), so the message text after it stays.
- **File access code** (`lib/file-access.mjs`, `lib/errors.mjs`, `lib/environment-readers.mjs`) is a copy of the
  local media plugins' (ffmpeg, image-tools, pdf-tools, excel-csv, ocr-tesseract, qr-code); keep the copies in step.

## Errors
| Kind | When |
|------|------|
| `setup_required` | `LOCAL_FILES_ALLOWED_DIRS` is unset, or none of its directories exist |
| `not_found` | The path is missing or outside the allowed directories |
| `invalid_input` | Bad arguments, not a regular file or not a directory, hard-linked file, invalid UTF-8, the file already exists (no overwrite), an allowed root as target, a non-empty directory to delete, content over the cap |
| `permission_denied` | An agent tried to write without `LOCAL_FILES_TOOL_ALLOW_WRITES=1`, or to overwrite |
| `cancelled` | A walk was cancelled or passed the tool deadline |
| `plugin_error` | The operating system refused (permissions, disk full); the reason is included |

## License
Apache-2.0
