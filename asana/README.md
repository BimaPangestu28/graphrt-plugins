# asana

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Asana REST API](https://developers.asana.com/reference/rest-api-reference)
(1.0) with a personal access token. It lists workspaces, users, projects and sections, lists, searches, creates,
updates and completes tasks and subtasks, and reads and adds comments. Every operation is a workflow node; all but
`delete_task` are also agent tools. Built with the declarative REST layer
([docs/declarative-plugins.md](../docs/declarative-plugins.md)).

## Features
- **Reads:** `get_me`, `list_workspaces`, `list_users`, `list_projects`, `get_project`, `list_sections`,
  `list_tasks`, `get_task`, `search_tasks` (premium workspaces), `list_subtasks`, `list_stories` (comments and history)
- **Writes:** `create_task`, `update_task`, `complete_task`, `create_subtask`, `create_section`,
  `add_task_to_section`, `add_comment`
- **Node only:** `delete_task`
- **`api_request`:** any other endpoint under `https://app.asana.com/api/1.0` (agent tools: GET on an allowlist of read paths)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- An Asana account

## Installation
```bash
graphrt plugin install ./asana
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Meaning |
|---|---|---|
| `ASANA_ACCESS_TOKEN` | yes | Personal access token (a node's `access_token`, e.g. an OAuth token, overrides it) |

**Getting a token:** in Asana open *My settings → Apps → Developer console* (<https://app.asana.com/0/my-apps>),
choose *Create new token* and copy it. The token acts as you, with all your access; there are no scopes for
personal access tokens. For an OAuth app, pass its access token as the node's `access_token`.

**Rate limits and pricing:** the API is free. Asana allows about 150 requests per minute on free workspaces and
1,500 on paid ones, plus concurrency and cost limits; a 429 is `rate_limited` and the client honours `Retry-After`.
`search_tasks` needs a premium workspace (or a premium team): otherwise Asana answers 402, reported as
`permission_denied`.

## Quick Start
```bash
ASANA_ACCESS_TOKEN=... graphrt run asana/example.yaml --plugins .
```
The example shows your name and your incomplete tasks in your first workspace.

## Usage
```yaml
- id: task
  type: asana.create_task
  name: "Follow up with {{#start.customer#}}"
  project_gids: ["1203456789012345"]
  assignee: me
  due_on: "2026-12-01"
- id: note
  type: asana.add_comment
  task_gid: "{{#task.data.gid#}}"
  text: "Created by the intake workflow"
```
- `data` is Asana's `data` field: an object for single resources, an array for lists. Asana returns compact
  objects (`gid`, `name`, ...) unless you ask for more with `opt_fields` (e.g. `[name, due_on, assignee.name]`).
- Lists are paged: pass `limit` (1-100, default 50) and the previous `next_cursor` as `cursor`.
- `list_tasks` needs exactly one of `project_gid`, `section_gid`, or `assignee` with `workspace_gid`.
- `search_tasks` has no paging; sort by `created_at` and filter by time to page manually.

## Agent policy
- All reads and writes except `delete_task` are tools. Creating tasks and comments stays within your Asana
  workspace (Asana has no public projects).
- Tool calls may only set `assignee` to `"me"` or a user gid: Asana also accepts an email address, and assigning
  to an outside address can invite that person. Emails need a workflow node. Followers and collaborators are not
  offered.
- `delete_task` is node only.
- `api_request` as a tool is GET-only and limited to tasks, projects, sections, users, workspaces, teams, tags,
  stories, portfolios, goals, custom fields, status updates, memberships and time tracking; webhooks,
  attachments (pre-signed download URLs), exports and audit logs are refused.

## Per-user tokens (multi-user agents)

Set `ASANA_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin asana`):

```yaml
tools: [asana/get_me]
tool_context:
  asana:
    access_token: "{{#start.asana_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is an OAuth access token (or personal API token) of that user.
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `ASANA_ACCESS_TOKEN` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
Asana errors are `{"errors": [{"message": ...}]}`; the first message is shown. 400 is `invalid_input`, 401
`auth_error`, 402 and 403 `permission_denied`, 404 `not_found`, 429 `rate_limited`. Creates and comments are never
retried after a timeout or 5xx; the error says how to check whether the write happened.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite on every operation; `test/asana.test.mjs` covers the
assignee and api_request guards and the error mapping. Not verified with a real Asana account; the live check used
an invalid token and got a clean `auth_error`.

## License
Apache-2.0
