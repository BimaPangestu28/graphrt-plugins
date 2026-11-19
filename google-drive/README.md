# google-drive

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Google Drive API v3](https://developers.google.com/workspace/drive/api/reference/rest/v3):
list and search files, read metadata, export Google files and download stored files into a directory, upload,
create folders, copy (e.g. templates), rename and move, read sharing, and (node only) share, trash and delete.
Shared drives are included.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs). Google
credentials use the same auth files as `google-sheets` (google-auth, google-token-endpoint and service-account, copied unchanged into [`lib/`](lib/)) through
[`lib/google-rest-auth.mjs`](lib/google-rest-auth.mjs). `search_files` builds an escaped Drive query from plain
fields ([`lib/drive-query.mjs`](lib/drive-query.mjs)); `upload_file` is hand-written
([`lib/upload-file.mjs`](lib/upload-file.mjs)) because Drive needs a `multipart/related` body.

## Features
- **Find:** `search_files` (name words, content words, type, folder, modified after an RFC 3339 date-time;
  trashed files excluded),
  `list_files` (raw `q`), `get_file`, `get_about`, `list_drives`
- **Content:** `export_file` (Google Docs/Sheets/Slides to PDF, DOCX, CSV, ...; Drive caps exports at 10 MB),
  `download_file` (stored files, up to 200 MB), both saved into `$GOOGLE_DRIVE_DOWNLOAD_DIR` and returning
  `{path, bytes, content_type}`
- **Write:** `upload_file` (up to 5 MB; optional conversion to a Google file), `create_folder`, `copy_file`,
  `update_file` (rename, describe, star, move with add/remove parents)
- **Sharing:** `list_permissions`; `share_file` and `remove_permission` (node only)
- **Remove:** `trash_file` and `delete_file` (node only)
- **`api_request`:** any other endpoint (GET only for agents)

Lists return `next_cursor` (Drive's `nextPageToken`); results use a compact `fields` set by default, which every
read lets you change. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Google Cloud project with the Google Drive API enabled

## Installation
```bash
graphrt plugin install ./google-drive
```

## Configuration
| Env var | Purpose |
|---|---|
| `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth refresh trio |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Path to a service account key file (scope `drive`); it sees only files shared with its email (and its own Drive) |
| `GOOGLE_ACCESS_TOKEN` | A ready access token (used only when neither of the above is set) |
| `GOOGLE_DRIVE_DOWNLOAD_DIR` | Absolute directory for `export_file` and `download_file` |
| `GOOGLE_DRIVE_UPLOAD_DIR` | Directory `upload_file` may read local files from (https URLs work without it) |
| `GOOGLE_DRIVE_TOOL_FOLDER_ALLOWLIST` | Comma-separated folder ids agent tools may put files into (`*` = any folder) |

Credential order: a node's `access_token` (needs `--trust-plugin google-drive`), then the refresh trio, then the
service account, then `GOOGLE_ACCESS_TOKEN`.

`GOOGLE_ACCESS_TOKEN` is ignored whenever the refresh trio or a service account key is configured (the
plugin cannot refresh after a 401, so it prefers a grant over a token of unknown age). An access token obtained
from a grant is cached in memory until a minute before it expires: after the grant is revoked or replaced in the
environment, calls keep using the cached token (failing with `auth_error` if Google rejects it) until it expires
or the plugin process restarts.

### Getting the credentials
1. Google Cloud console: enable the **Google Drive API**.
2. OAuth: create an OAuth client and get a refresh token for `https://www.googleapis.com/auth/drive` (full access;
   a **restricted** scope that needs Google's verification for public apps), or `drive.readonly`, or `drive.file`
   (only files the app created or the user opened with it).
3. Or a service account: download its JSON key and share folders with its `client_email`.

**Pricing / limits:** the API is free; storage counts against the account's quota. Default quota is 12,000
queries a minute per project and per user. Uploads here are limited to 5 MB (multipart); use the Drive UI or
another tool for larger files.

## Quick Start
```bash
GOOGLE_REFRESH_TOKEN=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... graphrt run google-drive/example.yaml --plugins .
```

## Usage
```yaml
- id: template
  type: google-drive.search_files
  name_contains: Invoice template
  mime_type: application/vnd.google-apps.document
- id: copy
  type: google-drive.copy_file
  file_id: "{{#template.data.0.id#}}"
  name: "Invoice {{#start.number#}}"
  parent_ids: ["{{#start.folder_id#}}"]
- id: pdf
  type: google-drive.export_file
  file_id: "{{#copy.data.id#}}"
  mime_type: application/pdf          # saved into $GOOGLE_DRIVE_DOWNLOAD_DIR
```

## Agent policy
- Reads, exports, downloads, uploads, folders, copies and `update_file` are tools.
- Tool calls that put a file into a folder (`upload_file` `folder_id`, `copy_file`/`create_folder` `parent_ids`,
  `update_file` `add_parents`) need every such folder id in `GOOGLE_DRIVE_TOOL_FOLDER_ALLOWLIST` (or `*`).
  Otherwise an agent could copy or move the user's files into a folder someone else shared with them. Without the
  allowlist, tools can only use the default location (no folder) or keep a file's existing folders. Nodes are not
  limited.
- `share_file`, `remove_permission`, `trash_file` and `delete_file` are node only: an agent cannot change who
  has access or remove files.

## Errors
Drive errors are `{"error": {"code", "message", "errors": [{"reason"}]}}`, mapped by `reason`: `authError` →
`auth_error`, `insufficientFilePermissions`/`forbidden` → `permission_denied`, `notFound` → `not_found`,
`badRequest`/`invalidArgument` → `invalid_input`, `rateLimitExceeded`/`userRateLimitExceeded` (Drive sends these
as 403) and 429 → `rate_limited` (retried). Creates and uploads are never retried after an unknown outcome:
search for the name first.

## Testing
```bash
npm test          # from the repo root
```
Generated contract suite plus tests for query escaping, the multipart/related upload, size and directory limits,
node-only operations and the 403 rate-limit mapping. Verified live only with an invalid token (`auth_error`).

## Changelog
### 0.1.0 (unreleased)
- **Breaking:** `share_file` parameter `type` is now `grantee_type` (still sent to the Drive API as `type`). graphrt takes `type` from every workflow node, so the old name could never be set from a node (the required field made the node fail to load); `share_file` is node only, so it was unusable before.

## License
Apache-2.0
