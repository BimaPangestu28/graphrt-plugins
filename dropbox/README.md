# dropbox

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Dropbox API v2](https://www.dropbox.com/developers/documentation/http/documentation),
acting as the signed-in user: account and space usage, list and search files, metadata, download into a
directory, upload up to 150 MB, create folders, move and copy, and (workflow nodes only) delete, shared links and
temporary links.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs).
Dropbox's content endpoints take their arguments as JSON in the `Dropbox-API-Arg` header, which
[`lib/dropbox-api-arg.mjs`](lib/dropbox-api-arg.mjs) builds (ASCII-escaped, as Dropbox requires). Agent
destinations are checked by [`lib/path-policy.mjs`](lib/path-policy.mjs).

## Features
- **Account:** `get_current_account`, `get_space_usage`
- **Find:** `list_folder` + `list_folder_continue`, `search` (search_v2) + `search_continue`, `get_metadata`
- **Content:** `download_file` (into `$DROPBOX_DOWNLOAD_DIR`, up to 500 MB, returns `{path, bytes, content_type}`),
  `upload_file` (https URL or a local file inside `$DROPBOX_UPLOAD_DIR`, up to 150 MB; mode add or overwrite)
- **Write:** `create_folder`, `move`, `copy`
- **Node only:** `delete`, `create_shared_link`, `list_shared_links`, `get_temporary_link`
- **`api_request`:** any other endpoint from a workflow node (every Dropbox endpoint is a POST, and agent tools may
  only send GET, so agents cannot use it)

Dropbox pages with its own cursor: `list_folder` and `search` return `cursor` and `has_more`, and the next page
comes from `list_folder_continue` / `search_continue` with that cursor (so these operations return the whole
response, not `next_cursor`). Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Dropbox app (App Console) with the scopes below

## Installation
```bash
graphrt plugin install ./dropbox
```

## Configuration
| Env var | Purpose |
|---|---|
| `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` | OAuth refresh-token grant (short-lived access tokens are fetched and cached) |
| `DROPBOX_DOWNLOAD_DIR` | Absolute directory for `download_file` |
| `DROPBOX_UPLOAD_DIR` | Directory `upload_file` may read local files from (https URLs work without it) |
| `DROPBOX_TOOL_PATH_ALLOWLIST` | Comma-separated path prefixes agent tools may upload, move or copy into (e.g. `/Agent,/Inbox`; `*` = anywhere) |
| `DROPBOX_TOOL_ALLOW_MOVE` | `1` lets agent tools call `move` and `copy` |

A workflow node may pass `access_token` instead (needs `--trust-plugin dropbox`).

### Getting the credentials
1. [App Console](https://www.dropbox.com/developers/apps): create an app (Scoped access; App folder or Full Dropbox).
2. Permissions tab: enable `account_info.read`, `files.metadata.read`, `files.content.read`, `files.content.write`,
   and for the node-only link operations `sharing.read` and `sharing.write`. Changing scopes needs a new token.
3. Get a refresh token with the OAuth code flow and `token_access_type=offline`:
   open `https://www.dropbox.com/oauth2/authorize?client_id=<APP_KEY>&response_type=code&token_access_type=offline`,
   then exchange the code at `https://api.dropboxapi.com/oauth2/token` (`grant_type=authorization_code`).

**Pricing / limits:** the API is free; storage counts against the account's plan. Dropbox rate-limits per user
and answers 429 (`too_many_requests` or `too_many_write_operations`) with Retry-After, which the client honours.
Uploads here are single requests up to 150 MB (Dropbox's limit for `/files/upload`; larger files need upload
sessions, not supported). Content search needs a paid plan.

## Quick Start
```bash
DROPBOX_APP_KEY=... DROPBOX_APP_SECRET=... DROPBOX_REFRESH_TOKEN=... graphrt run dropbox/example.yaml --plugins .
```

## Usage
```yaml
- id: found
  type: dropbox.search
  query: invoice
  file_extensions: [pdf]
  max_results: 5
- id: file
  type: dropbox.download_file
  path: "{{#found.data.matches.0.metadata.metadata.path_lower#}}"
```
Paths start with `/` (`""` is the root for `list_folder`) or are `id:...` from metadata.

## Agent policy
- Reads (account, list, search, metadata, download) are tools.
- `upload_file`, `move` and `copy` write to a destination: as tools, the destination must be inside
  `DROPBOX_TOOL_PATH_ALLOWLIST` (case-insensitive prefix match on whole path segments). Without it they are
  refused. Paths with `.`/`..` and `id:`/`ns:`/`rev:` destinations are refused for tools because where they point
  cannot be checked. Shared folders appear as ordinary paths, so this keeps agents from copying private files into
  folders other people can read.
- `move` and `copy` also need `DROPBOX_TOOL_ALLOW_MOVE=1`.
- `create_folder` is a tool (it creates nothing readable).
- `delete`, `create_shared_link` and `list_shared_links` (public exposure) and `get_temporary_link` (a 4-hour URL
  anyone can download from) are node only.
- Creates and uploads are never retried after an unknown outcome; the error says how to check.

## Errors
- 401 (`invalid_access_token`, `expired_access_token`): `auth_error` (the token is refreshed once first);
  `missing_scope`: `permission_denied`.
- 409 is Dropbox's endpoint-specific error; the message carries `error_summary`, e.g. `path/not_found/..`.
- 400 (bad arguments, plain text): `invalid_input`. 429: `rate_limited` with Retry-After.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite for every operation; `test/dropbox.test.mjs` covers the
`Dropbox-API-Arg` header (ASCII escaping, folded upload options, no body or Content-Type on download), the path
allowlist and the move opt-in. Checked live only with invalid credentials (clean `auth_error`); not verified with a
real Dropbox account.

## License
Apache-2.0
