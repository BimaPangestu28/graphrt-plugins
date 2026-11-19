# google-drive operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `google-drive.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_about` | The signed-in user and storage quota | fields |
| `list_files` | Files matching a raw Drive query (q), e.g. "'<folder id>' in parents and trashed = false" | q, order_by, corpora, drive_id, include_items_from_all_drives, fields, cursor, limit |
| `search_files` | Find files by name words, content words, type, folder or modification date (not trashed by default) | name_contains, full_text, mime_type, folder_id, modified_after, include_trashed, order_by, corpora, drive_id, include_items_from_all_drives, fields, cursor, limit |
| `get_file` | Metadata of a file or folder | **file_id**, fields |
| `export_file` | Export a Google Docs/Sheets/Slides/Drawings file (e.g. to PDF, DOCX, CSV) into $GOOGLE_DRIVE_DOWNLOAD_DIR (Drive allows up to 10 MB) | **file_id**, **mime_type** |
| `download_file` | Download a stored (non-Google) file's content into $GOOGLE_DRIVE_DOWNLOAD_DIR; use export_file for Google Docs/Sheets/Slides | **file_id** |
| `list_permissions` | Who a file or folder is shared with | **file_id**, fields |
| `list_drives` | Shared drives the user can see | q, cursor, limit |
| `create_folder` | Create a folder (in My Drive's root unless a parent is given) | **name**, parent_ids, fields |
| `copy_file` | Copy a file (e.g. a template) with a new name and folder | **file_id**, name, parent_ids, fields |
| `update_file` | Rename a file, change its description or star, or move it between folders | **file_id**, name, description, starred, add_parents, remove_parents, fields |
| `share_file` | Give a user, group, domain or anyone access to a file or folder | **file_id**, **role**, **grantee_type**, email_address, domain, send_notification_email, email_message |
| `remove_permission` | Remove one permission from a file or folder | **file_id**, **permission_id** |
| `trash_file` | Move a file or folder to the trash (restorable for 30 days) | **file_id** |
| `delete_file` | Delete a file permanently, skipping the trash | **file_id** |
| `upload_file` | Upload a file up to 5 MB (https URL, or an absolute path inside $GOOGLE_DRIVE_UPLOAD_DIR) into a folder, optionally converting it to a Google Docs/Sheets/Slides file | **file**, name, folder_id, description, convert_to, content_type |
| `api_request` | Call any Google Drive API endpoint that has no dedicated operation, e.g. path "/files?q=starred%20%3D%20true". Only the API's own host is allowed. | method, **path**, query, body |
