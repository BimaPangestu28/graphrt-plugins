# onedrive

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the signed-in user's OneDrive (personal or
OneDrive for Business) through [Microsoft Graph v1.0](https://learn.microsoft.com/en-us/graph/api/resources/onedrive):
browse folders, get items by id or path, search, download into a directory, upload up to 250 MB, create folders,
rename, move and copy, read sharing, and (workflow nodes only) create sharing links, invite people and delete.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs). The
tenant-dependent OAuth token URL and the Graph error mapping are copied from the `microsoft-graph` plugin
([`lib/graph-tenant.mjs`](lib/graph-tenant.mjs), [`lib/graph-errors.mjs`](lib/graph-errors.mjs)), with the same
`MICROSOFT_*` env vars, so one app registration serves both. `download_item` is hand-written
([`lib/download-item.mjs`](lib/download-item.mjs), see Agent policy).

## Features
- **Browse:** `get_drive` (quota), `list_drives`, `list_root_children`, `list_children`, `get_item`,
  `get_item_by_path` (e.g. `Documents/q3.pdf`), `search` (names, metadata and content)
- **Content:** `download_item` (into `$ONEDRIVE_DOWNLOAD_DIR`, up to 250 MB), `upload_file` (https URL or a local
  file inside `$ONEDRIVE_UPLOAD_DIR`, up to 250 MB; replace, rename or fail on a name conflict)
- **Write:** `create_folder`, `update_item` (rename, description, move), `copy_item` (asynchronous: Graph answers 202)
- **Sharing:** `list_permissions`; `create_sharing_link` and `invite` (node only)
- **Remove:** `delete_item` (node only; to the recycle bin)
- **`api_request`:** any other Graph endpoint (GET only for agents)

Lists return `next_cursor` (Graph's `@odata.nextLink`) and use a compact `$select` by default. Full reference:
[OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- An app registration in Microsoft Entra ID with delegated Graph permissions

## Installation
```bash
graphrt plugin install ./onedrive
```

## Configuration
| Env var | Purpose |
|---|---|
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REFRESH_TOKEN` | Delegated refresh-token grant |
| `MICROSOFT_TENANT_ID` | Tenant id or domain for single-tenant apps; default `common` (`consumers` for personal-only apps) |
| `ONEDRIVE_DOWNLOAD_DIR` | Absolute directory for `download_item` |
| `ONEDRIVE_UPLOAD_DIR` | Directory `upload_file` may read local files from (https URLs work without it) |
| `ONEDRIVE_TOOL_FOLDER_ALLOWLIST` | Comma-separated folder item ids agent tools may put items into besides root (`*` = any folder) |

A workflow node may pass `access_token` instead (needs `--trust-plugin onedrive`).

### Getting the credentials and scopes
1. Entra admin center → App registrations → New registration (accounts in your tenant, or any org and personal
   accounts). Add a client secret and a redirect URI.
2. API permissions (delegated): `Files.ReadWrite` (your own drive) and `offline_access`; add `Files.ReadWrite.All`
   for items shared with you. Work accounts may need admin consent.
3. Get a refresh token with the authorization code flow
   (`https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize?...&scope=Files.ReadWrite offline_access`).

The plugin requests `https://graph.microsoft.com/.default offline_access` when refreshing, which means "the
permissions this user already consented to for the app"; that keeps one refresh token usable by this plugin and
`microsoft-graph` without asking for scopes the app was never granted.

**Pricing / limits:** Graph is free; storage counts against the account's quota. Graph throttles per app and user
with 429 and Retry-After, which the client honours. Simple upload is limited to 250 MB (upload sessions for larger
files are not supported).

## Quick Start
```bash
MICROSOFT_CLIENT_ID=... MICROSOFT_CLIENT_SECRET=... MICROSOFT_REFRESH_TOKEN=... graphrt run onedrive/example.yaml --plugins .
```

## Usage
```yaml
- id: report
  type: onedrive.get_item_by_path
  item_path: Documents/Reports/q3.pdf
- id: file
  type: onedrive.download_item
  item_id: "{{#report.data.id#}}"
```

## Agent policy
- Reads are tools. Tool results never contain `@microsoft.graph.downloadUrl` (a short-lived URL that downloads the
  file without any credential), thumbnail `url`s (also pre-authenticated) or a sharing link's `webUrl`/`webHtml` (for anonymous links, the URL is the
  access); all are removed at any depth, including from `api_request`, before truncation. Workflow nodes get the
  full response.
- `download_item` reads the item's download URL, checks it is https on a OneDrive or SharePoint host
  (`*.1drv.com`, `*.livefilestore.com`, `*.sharepoint.com`, `*.onedrive.com`, `*.microsoftpersonalcontent.com`), downloads it without the bearer
  token through the shared public-https fetch (every redirect hop checked, size capped) and returns only
  `{item, path, bytes, content_type}`.
- `upload_file`, `create_folder`, `update_item` (move) and `copy_item` as tools may only put items into `root` or
  a folder listed in `ONEDRIVE_TOOL_FOLDER_ALLOWLIST`: folders shared by other people can sit in your own drive,
  so this keeps agents from copying private files where others can read them. Tool names (`file_name`, `name`)
  may not contain `/`, `\` or `:` (a path would land outside the checked folder), and `copy_item` refuses
  `parent_drive_id` for tools (copies stay in your own drive).
- `create_sharing_link`, `invite` and `delete_item` are node only.
- Creates, uploads and copies are never retried after an unknown outcome; the error says how to check.

## Errors
Graph errors are `{"error": {"code", "message"}}`: `InvalidAuthenticationToken` and 401 → `auth_error` (refreshed
once first), `accessDenied` → `permission_denied`, `itemNotFound` → `not_found`, `nameAlreadyExists`,
`invalidRequest` → `invalid_input`, 429/`activityLimitReached` → `rate_limited`. Token endpoint failures
(`invalid_grant`, `invalid_client`) are `auth_error`.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite for every declarative operation; `test/onedrive.test.mjs`
covers OData quote escaping in `search`, URL stripping for tools, `download_item` (no bearer on the download,
host check, folders refused) and the folder allowlist. Checked live only with invalid credentials (clean
`auth_error`); not verified with a real Microsoft account.

## License
Apache-2.0
