# local-files operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `local-files.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_allowed_directories` | Lists the directories (LOCAL_FILES_ALLOWED_DIRS) this plugin may read and write, as real paths, and whether each exists |  |
| `stat` | Describes a file or directory inside the allowed directories (type, size, times, permission bits, hard links) without opening it; files with more than one hard link are refused | **path** |
| `read_file` | Reads a regular file inside the allowed directories as UTF-8 text or base64, up to max_bytes from offset; `truncated` and `next_offset` say when more remains | **path**, encoding, offset, max_bytes |
| `list_directory` | Lists a directory inside the allowed directories (name, type, size, modified time), optionally recursing up to max_depth; symlinks are shown, never followed | path, max_depth, include_hidden, limit |
| `search_files` | Finds files inside the allowed directories by name glob (* and ?) and/or by a plain-text substring in their content (no regular expressions); bounded by depth, entries scanned, matches per file and results | path, name_pattern, content, case_sensitive, include_hidden, max_depth, max_results, max_matches_per_file |
| `write_file` | Writes UTF-8 text or base64 bytes to a new file inside the allowed directories (staged, then published atomically). Existing files are never replaced unless a workflow node passes overwrite. Agents need LOCAL_FILES_TOOL_ALLOW_WRITES=1 | **path**, **content**, encoding, overwrite, create_parents |
| `delete_path` | Deletes one file, symlink (the link itself) or empty directory inside the allowed directories; never recursive, never an allowed directory itself (workflow nodes only) | **path** |
