# onedrive operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `onedrive.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_drive` | The user's OneDrive: id, type (personal or business), owner and storage quota |  |
| `list_drives` | Drives the user can reach directly (usually one) | cursor, limit |
| `list_root_children` | Files and folders in the root of the drive | select, order_by, cursor, limit |
| `list_children` | Files and folders in a folder | **item_id**, select, order_by, cursor, limit |
| `get_item` | Metadata of a file or folder by id | **item_id**, select |
| `get_item_by_path` | Metadata of a file or folder by its path from the root, e.g. "Documents/Reports/q3.pdf" | **item_path**, select |
| `search` | Search the drive's file names, metadata and content | **query**, select, cursor, limit |
| `list_permissions` | Who a file or folder is shared with (roles, users, link type and scope; link URLs are left out for agents) | **item_id** |
| `upload_file` | Upload a file up to 250 MB (https URL, or an absolute path inside $ONEDRIVE_UPLOAD_DIR) into a folder, creating or replacing it | **parent_id**, **file_name**, **file**, conflict_behavior |
| `create_folder` | Create a folder in a parent folder (parent_id root for the top level) | **parent_id**, **name**, conflict_behavior |
| `update_item` | Rename a file or folder, change its description, or move it to another folder | **item_id**, name, description, parent_id |
| `copy_item` | Copy a file or folder (asynchronous: Graph answers 202 and copies in the background) | **item_id**, parent_id, parent_drive_id, name, conflict_behavior |
| `create_sharing_link` | Create a view, edit or embed link (anonymous links let anyone with the URL open the item) | **item_id**, **link_type**, scope, expiration_date_time, password |
| `invite` | Give people access to an item and optionally email them an invitation | **item_id**, **recipients**, **roles**, require_sign_in, send_invitation, message |
| `delete_item` | Move a file or folder to the recycle bin | **item_id** |
| `download_item` | Download a file's content into $ONEDRIVE_DOWNLOAD_DIR (up to 250 MB); returns {item, path, bytes, content_type} | **item_id** |
| `api_request` | Call any Microsoft Graph endpoint that has no dedicated operation, e.g. path "/me/drive/root/delta". Only the API's own host is allowed. | method, **path**, query, body |
