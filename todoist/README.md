# todoist

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the unified [Todoist API v1](https://developer.todoist.com/api/v1/)
(`https://api.todoist.com/api/v1`), which replaced the REST API v2 and Sync API v9 (both shut down in 2026; old
`/rest/v2` URLs answer 410). Projects, sections, tasks (list, filter, completed, get, create, Quick Add, update,
move, complete, reopen), labels and comments. Deleting tasks is node only.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs). The only
custom code ([`lib/todoist-policy.mjs`](lib/todoist-policy.mjs)) removes token fields from `get_user` and limits
`api_request` for agent tools.

## Features
- **Projects and sections:** `list_projects`, `get_project`, `create_project`, `update_project`, `list_sections`,
  `create_section`
- **Tasks:** `list_tasks` (by project, section, parent, label or ids), `filter_tasks` (Todoist filter syntax, e.g.
  `today | overdue`, `#Work & p1`, `assigned to: me`), `list_completed_tasks` (by completion date), `get_task`,
  `create_task`, `quick_add_task` (one line in Quick Add syntax), `update_task`, `move_task`, `close_task`,
  `reopen_task`, `delete_task` (node only)
- **Labels and comments:** `list_labels`, `list_comments`, `add_comment`
- **`api_request`:** any other v1 endpoint (agents: GET on `/projects`, `/sections`, `/tasks`, `/labels`, `/comments`
  and `/folders` paths only)

Lists return `next_cursor` (Todoist's cursor; `limit` up to 200, default 50). Full reference:
[OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Todoist account

## Installation
```bash
graphrt plugin install ./todoist
```

## Configuration
| Env var | Purpose |
|---|---|
| `TODOIST_API_TOKEN` | Personal API token (or an OAuth access token), sent as `Authorization: Bearer ...` |

A node may pass `access_token` instead (needs `--trust-plugin todoist`).

### Getting the credential
Todoist: **Settings** → **Integrations** → **Developer** → copy the API token. It has full access to your account.
For an app acting for other users, use OAuth (`https://todoist.com/oauth/authorize`, scopes such as `data:read`,
`data:read_write`, `data:delete`) and pass the access token; this plugin does not refresh OAuth tokens.

**Pricing / limits:** the API is free. Todoist limits requests per user (about 1,000 requests per 15 minutes for
REST-style calls); over the limit it answers 429 (`rate_limited`, honouring `retry_after`).

## Quick Start
```bash
TODOIST_API_TOKEN=... graphrt run todoist/example.yaml --plugins . --trust-plugin todoist
```
The example lists today's and overdue tasks and your projects.

## Usage
```yaml
- id: task
  type: todoist.create_task
  content: "Send invoice to {{#start.client#}}"
  project_id: "6XR4H993xv8H5qCR"
  due_string: "next friday at 10"
  priority: 4
  labels: [billing]
- id: note
  type: todoist.add_comment
  task_id: "{{#task.data.id#}}"
  content: Created by the billing workflow
```
- `priority` 4 is the most urgent (p1 in the apps), 1 is normal.
- Due dates: `due_string` (natural language, also recurring: `every monday`), or `due_date` (YYYY-MM-DD), or
  `due_datetime` (RFC 3339 UTC). `deadline_date` is a separate hard deadline.
- `list_completed_tasks` needs `since` and `until` (a range of up to about 3 months) and returns Todoist's `items`.
- `list_comments` and `add_comment` take exactly one of `task_id` or `project_id`.

## Agent policy
- Every operation except `delete_task` is available to agents. Comments and assignments notify only collaborators
  of a shared project (people who already have access).
- `delete_task` is node only.
- `close_task` is never retried after an unknown outcome: closing a recurring task again would skip an occurrence.
  `update_task`, `move_task` and `reopen_task` set a state and are retried after 5xx and network errors.
- `get_user` never returns the account's `token` or the token-bearing `websocket_url` (nodes included).
- `api_request` is GET-only for agents and limited to project, section, task, label, comment and folder paths; other
  GET endpoints (`/user` with the token, backups with download links, uploads, forwarding email addresses,
  workspace invitations) are refused for tools.

## Errors
Todoist errors are `{"error_tag": "...", "error_code": ..., "error": "...", "http_code": ..., "error_extra": {...}}`
and appear as `error (error_tag)`. `UNAUTHORIZED` (and any 401) is `auth_error`, `FORBIDDEN` `permission_denied`,
`NOT_FOUND` `not_found`, `INVALID_ARGUMENT_VALUE` and other 400s `invalid_input`, 429 `rate_limited`. Creates,
Quick Add, comments and close are never retried after an unknown outcome; the error says how to check.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite for every operation; `test/todoist.test.mjs` covers
token stripping, error tags, cursors, the close no-retry rule and the api_request allowlist. Live-checked only
with an invalid token (`auth_error: API error 401: Unauthorized (UNAUTHORIZED)`); not verified with a real account.

## License
Apache-2.0
