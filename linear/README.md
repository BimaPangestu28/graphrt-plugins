# linear

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the [Linear GraphQL API](https://linear.app/developers/graphql).
It lists, searches, reads, creates and updates issues, reads and writes comments, and reads projects, teams, workflow
states and users. Every operation sends a fixed GraphQL document with typed variables, so neither workflows nor
agents write GraphQL by hand. It is built with the declarative REST layer ([`definition.mjs`](definition.mjs)).

## Features
- **Workspace:** `get_viewer`, `list_teams`, `get_team` (with workflow states and members), `list_workflow_states`,
  `list_users`
- **Issues:** `list_issues` (any `IssueFilter`), `search_issues` (full text), `get_issue` (with sub-issues and
  comments), `create_issue`, `update_issue`, `delete_issue` (node only, moves to trash)
- **Comments:** `list_comments`, `create_comment`
- **Projects:** `list_projects`, `get_project` (with issues)
- **`api_request`:** raw GraphQL as a workflow node: `method: POST`, `path: /graphql`,
  `body: {query, variables}` (GET only for agents)

Lists are Relay connections: `limit` is `first` (default 50, max 250) and `next_cursor` is `pageInfo.endCursor` (null
when `hasNextPage` is false). `issue_id` of `get_issue`, `update_issue` and `list_comments` may be an identifier such as `ENG-123`; `create_comment`
needs the issue's UUID (`get_issue` returns it as `id`). Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- Network access to `api.linear.app`

## Installation
```bash
graphrt plugin install ./linear
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `LINEAR_API_KEY` | yes | Personal API key (`lin_api_...`), sent as `Authorization: <key>` |
| `LINEAR_TOOL_ALLOW_WRITE` | no | `1` lets agent tools create and update issues and add comments |

**Getting a key:** Linear → Settings → Account → Security & access → Personal API keys → New key. You can limit a
key to read access or to some teams; writes need a key with write access. The key acts as your user. For an OAuth
app token, pass it from a node as `access_token: "Bearer <token>"` (the value is used as the whole header).

**Rate limits:** with API keys, 2,500 requests and 3,000,000 complexity points an hour per user (shared by all of that
user's keys; more on Business and Enterprise), and at most 10,000 complexity points per query. A limit hit is HTTP 429
with code `RATELIMITED` (`rate_limited`, honours `Retry-After`). Keep `limit` modest for nested queries such as
`get_issue`.

## Quick Start
```bash
LINEAR_API_KEY=lin_api_... graphrt run linear/example.yaml --plugins .
```
The example prints your name and workspace and the ten most recently updated open issues.

## Usage
```yaml
- id: team
  type: linear.get_team
  team_id: "{{#start.team_id#}}"
- id: create
  type: linear.create_issue
  team_id: "{{#start.team_id#}}"
  issue_title: "Nightly import failed"
  description: "See the run log."
  priority: 2
  state_id: "{{#team.data.states.nodes.0.id#}}"
```
Filters use Linear's filter objects, e.g. `{"assignee": {"email": {"eq": "ana@acme.com"}}, "priority": {"lte": 2}}`.

## Agent policy
- **Reads** are agent tools.
- **Opt-in writes** (`LINEAR_TOOL_ALLOW_WRITE=1`): `create_issue`, `update_issue`, `create_comment`.
- **Node only:** `delete_issue`.
- `update_issue` without any field to change is refused with `invalid_input`.
- `api_request` is GET-only for agents (no mutations).
- Creates and comments are never retried after an unknown outcome; the error says how to check.

## Per-user tokens (multi-user agents)

Set `LINEAR_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin linear`):

```yaml
tools: [linear/get_viewer]
tool_context:
  linear:
    access_token: "{{#start.linear_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is an OAuth access token (or personal API token) of that user.
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `LINEAR_API_KEY` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
GraphQL errors are reported even when Linear answers HTTP 200 (`errors[0].message` plus the code):
`AUTHENTICATION_ERROR` is `auth_error`, `FORBIDDEN` `permission_denied`, `RATELIMITED` `rate_limited`,
`INVALID_INPUT` `invalid_input`; other codes are `api_error`. A response with partial data and errors is an error.

## Testing
```bash
npm test          # from the repo root
```
Contract suite for every operation (exact query document and variables), plus checks that every document declares
exactly the variables it uses, the header format, connection paging and GraphQL error mapping. Live check: the
example with an invalid key gives `auth_error: API error 401: Authentication required, not authenticated (AUTHENTICATION_ERROR)`.

## License
Apache-2.0
