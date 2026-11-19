# sftp operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `sftp.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_directory` | Lists a directory on the SFTP server inside SFTP_ROOT (name, type, size, modified time, permission bits), sorted by name | path, include_hidden, limit |
| `stat` | Describes a file or directory on the SFTP server inside SFTP_ROOT (type, size, modified time, permission bits) | **path** |
| `read_file` | Reads a file on the SFTP server inside SFTP_ROOT as UTF-8 text or base64, up to max_bytes from offset; `truncated` says when more remains | **path**, encoding, offset, max_bytes |
| `download` | Downloads a file from the SFTP server (inside SFTP_ROOT) into a new file with a generated name in SFTP_OUTPUT_DIR; nothing local is overwritten | **path**, output_name |
| `upload` | Uploads a local file from SFTP_INPUT_DIRS to the SFTP server inside SFTP_ROOT: staged under a temporary name, then renamed. Existing files are never replaced unless a workflow node passes overwrite. Agents need SFTP_TOOL_ALLOW_WRITES=1 | **local_path**, **path**, overwrite, create_parents |
| `make_directory` | Creates a directory on the SFTP server inside SFTP_ROOT (with create_parents, missing parents too). Agents need SFTP_TOOL_ALLOW_WRITES=1 | **path**, create_parents |
| `delete_path` | Deletes one file, symlink (the link itself) or empty directory on the SFTP server inside SFTP_ROOT; never recursive, never SFTP_ROOT itself (workflow nodes only) | **path** |
