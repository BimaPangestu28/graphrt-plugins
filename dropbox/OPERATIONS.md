# dropbox operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `dropbox.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_current_account` | The signed-in user's account: name, email, account type, root namespace |  |
| `get_space_usage` | Used and allocated storage in bytes |  |
| `list_folder` | Entries of a folder ("" for the root); returns entries, cursor and has_more (continue with list_folder_continue) | path, recursive, include_deleted, include_mounted_folders, page_size |
| `list_folder_continue` | Next page of list_folder (or changes since an earlier cursor) | **cursor** |
| `get_metadata` | Metadata of a file or folder (.tag file\|folder\|deleted, id, path_display, size, server_modified, rev) | **path**, include_deleted |
| `search` | Search file and folder names (and content on paid plans); returns matches, cursor and has_more (continue with search_continue) | **query**, folder_path, max_results, filename_only, file_status, file_extensions, file_categories |
| `search_continue` | Next page of search | **cursor** |
| `download_file` | Download a file's content into $DROPBOX_DOWNLOAD_DIR (up to 500 MB); returns {path, bytes, content_type} | **path** |
| `upload_file` | Upload a file up to 150 MB (https URL, or an absolute path inside $DROPBOX_UPLOAD_DIR) to a Dropbox path | **file**, **path**, mode, autorename, mute, strict_conflict |
| `create_folder` | Create a folder at a path | **path**, autorename |
| `move` | Move or rename a file or folder (as an agent tool only when DROPBOX_TOOL_ALLOW_MOVE=1) | **from_path**, **to_path**, autorename, allow_ownership_transfer |
| `copy` | Copy a file or folder (as an agent tool only when DROPBOX_TOOL_ALLOW_MOVE=1) | **from_path**, **to_path**, autorename, allow_ownership_transfer |
| `delete` | Delete a file or folder (restorable from Dropbox's deleted files for a while) | **path** |
| `create_shared_link` | Create a shared link to a file or folder (who can open it depends on settings and the account's defaults) | **path**, audience, access, expires, allow_download |
| `list_shared_links` | Shared links of a path, or all of the user's links without a path; returns links, cursor and has_more | path, cursor, direct_only |
| `get_temporary_link` | A 4-hour direct download link to a file (anyone with it can download) | **path** |
| `api_request` | Call any Dropbox API v2 endpoint that has no dedicated operation, e.g. path "/files/list_folder". Only the API's own host is allowed. Every Dropbox endpoint is a POST (method "POST", JSON body), so this works from workflow nodes only. | method, **path**, query, body |
