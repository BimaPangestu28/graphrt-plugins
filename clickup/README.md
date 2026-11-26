# clickup

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the [ClickUp API v2](https://developer.clickup.com/reference):
browse the hierarchy (workspaces, spaces, folders, lists), list and filter tasks, read, create and update tasks,
read and add comments, and read time tracking. Deleting tasks is node only.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs). The only
custom code is the agent-tool allowlist for `api_request` ([`lib/api-request-policy.mjs`](lib/api-request-policy.mjs)).
ClickUp v2 calls workspaces "teams", so `team_id` is a workspace id.

## Features
- **Hierarchy:** `get_user`, `list_teams` (workspaces with members), `list_spaces`, `get_space`, `list_folders`,
  `list_lists`, `list_folderless_lists`, `get_list`
- **Tasks:** `list_tasks` (one list), `search_tasks` (a whole workspace filtered by spaces, folders, lists, statuses,
  assignees, tags, due and update dates), `get_task`, `get_time_in_status`, `create_task`, `update_task`
  (name, description or markdown, status, priority, dates, estimate, points, archive, add/remove assignees),
  `delete_task` (node only)
- **Comments:** `list_comments` (25 newest; older ones with `start` + `start_id`), `add_comment`
- **Time tracking (read):** `list_time_entries` (date range, by space, folder, list or task, billable)
- **`api_request`:** any other v2 endpoint (agents: GET on hierarchy, task, comment, view and time-entry paths only)

Task lists page with `next_cursor` (ClickUp's `page`, 100 tasks a page, starting at 0). ClickUp's `last_page` flag is
not used, so the listing ends with one empty page. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A ClickUp account

## Installation
```bash
graphrt plugin install ./clickup
```

## Configuration
| Env var | Purpose |
|---|---|
| `CLICKUP_API_TOKEN` | Personal API token (`pk_...`), sent as `Authorization: pk_...` |

A node may pass `access_token` instead (needs `--trust-plugin clickup`). For an OAuth access token pass
`Bearer <token>` as the value, because OAuth tokens need the prefix and personal tokens must not have it.

### Getting the credential
ClickUp: avatar → **Settings** → **Apps** → **API Token** → Generate. The token acts as you, in every workspace
you belong to; personal tokens do not expire. There are no scopes: the token can do what your user can.

**Pricing / limits:** the API is free on every plan. Rate limits are per token: 100 requests a minute on Free,
Unlimited and Business plans, more on Business Plus and Enterprise. Over the limit ClickUp answers 429
(`rate_limited`, with the reset time in `X-RateLimit-Reset`).

## Quick Start
```bash
CLICKUP_API_TOKEN=pk_... graphrt run clickup/example.yaml --plugins . --trust-plugin clickup
```
The example lists your workspaces and the spaces of the first one.

## Usage
```yaml
- id: open
  type: clickup.search_tasks
  team_id: "9001234"
  list_ids: ["901234567"]
  statuses: ["to do", "in progress"]
  order_by: due_date
- id: done
  type: clickup.update_task
  task_id: "{{#open.data.0.id#}}"
  status: complete
- id: note
  type: clickup.add_comment
  task_id: "{{#open.data.0.id#}}"
  comment_text: Closed by the nightly workflow
```
- Dates are Unix time in **milliseconds** (`due_date`, `start_date`, `*_gt`/`*_lt` filters, time entries).
- `priority` is 1 (urgent) to 4 (low). Custom task ids (e.g. `DEV-12`) need `custom_task_ids: true` and `team_id`.
- Custom field values on create: `custom_fields: [{id: "<field id>", value: ...}]`.

## Agent policy
- Every operation except `delete_task` is available to agents. Creating tasks and comments notifies the task's
  assignees and watchers (workspace members), as in the ClickUp app; `notify_all` (default false) only adds the
  creator.
- `delete_task` is node only.
- `api_request` is GET-only for agents and limited to the hierarchy, task, comment, view and time-entry reads:
  other GET endpoints (e.g. webhooks, which include their signing secret) are refused for tools.

## Per-user tokens (multi-user agents)

Set `CLICKUP_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin clickup`):

```yaml
tools: [clickup/get_user]
tool_context:
  clickup:
    access_token: "{{#start.clickup_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is an OAuth access token (or personal API token) of that user.
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `CLICKUP_API_TOKEN` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
ClickUp errors are `{"err": "...", "ECODE": "..."}` and appear as `message (ECODE)`. `OAUTH_017/019/021/025/077`
(missing, revoked or invalid token) are `auth_error`; `OAUTH_023/026/027/029` (workspace not authorized for the
token) are `permission_denied`; 404 is `not_found`, 429 `rate_limited`. Creates and comments are never retried
after an unknown outcome; the error says how to check.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite for every operation; `test/clickup.test.mjs` covers the
auth header, error codes, paging and the api_request allowlist. Live-checked only with an invalid token
(`auth_error: API error 401: Token invalid (OAUTH_025)`); not verified with a real account.

## License
Apache-2.0
