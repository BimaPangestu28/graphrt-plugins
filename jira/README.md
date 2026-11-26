# jira

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the
[Jira Cloud platform REST API v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/). It searches issues
with JQL (the current enhanced search endpoint, `/rest/api/3/search/jql`), reads and writes issues, moves them through
their workflow, comments, and lists projects, issue types and assignable users. It is built with the declarative
REST layer ([`definition.mjs`](definition.mjs)) plus plain-text parameters that are converted to Atlassian Document
Format ([`lib/adf.mjs`](lib/adf.mjs)).

## Features
- **Search:** `search_issues` (JQL, cursor paging with `nextPageToken`; sensible default `fields`)
- **Issues:** `get_issue`, `create_issue`, `update_issue`, `assign_issue`, `delete_issue` (node only)
- **Workflow:** `list_transitions`, `transition_issue`
- **Comments:** `list_comments`, `add_comment`
- **Projects and users:** `get_myself`, `list_projects`, `get_project`, `list_issue_types`, `find_assignable_users`
- **`api_request`:** any other v3 endpoint on your site (GET only for agents)

Rich text: v3 only accepts ADF for comment bodies and `description`. Pass plain text as `text` (`add_comment`) or
`description_text` (`create_issue`, `update_issue`) and it is converted (blank lines make paragraphs), or pass an ADF
document as `body`/`description` for formatting. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Jira Cloud site (`*.atlassian.net`). Jira Server/Data Center is not supported.

## Installation
```bash
graphrt plugin install ./jira
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `JIRA_SITE_URL` | yes | Your site, e.g. `https://acme.atlassian.net` (https, no path; must be on `atlassian.net`) |
| `JIRA_EMAIL` | yes | Email of the Atlassian account |
| `JIRA_API_TOKEN` | yes | API token of that account |
| `JIRA_TOOL_ALLOW_WRITE` | no | `1` lets agent tools create, update, assign and transition issues and add comments |

Requests use Basic auth (`email:token`) and act with that user's Jira permissions. `JIRA_SITE_URL` is validated at
every call: anything that is not a bare `https://<site>.atlassian.net` (no port, path or credentials) fails with `invalid_input`, so the credentials
are never sent elsewhere.

**Getting a token:** sign in at <https://id.atlassian.com/manage-profile/security/api-tokens> → Create API token
(Atlassian now asks for an expiry date; tokens last at most a year). Scoped API tokens use a different base URL
(`api.atlassian.com/ex/jira/<cloudId>`) and are **not supported** by this plugin: use a classic (unscoped) API token.
Use a dedicated bot account for
automations so writes are attributed clearly.

**Rate limits:** Jira Cloud applies cost-based limits per user and site; 429 is `rate_limited` and honours
`Retry-After`. The enhanced search returns no total count; page with `next_cursor`.

## Quick Start
```bash
JIRA_SITE_URL=https://acme.atlassian.net JIRA_EMAIL=you@acme.com JIRA_API_TOKEN=... \
  graphrt run jira/example.yaml --plugins .
```
The example prints your name and your open issues.

## Usage
```yaml
- id: transitions
  type: jira.list_transitions
  issue_key: OPS-12
- id: close
  type: jira.transition_issue
  issue_key: OPS-12
  transition_id: "{{#transitions.data.0.id#}}"
- id: note
  type: jira.add_comment
  issue_key: OPS-12
  text: "Closed by the nightly cleanup workflow."
```
- JQL must be bounded (e.g. by project); unbounded queries are rejected by Jira.
- `create_issue` needs `project_key`, `issue_type` (name from `list_issue_types`) and `summary`; custom fields go
  through `api_request` as a node.

## Agent policy
- **Reads** are agent tools.
- **Opt-in writes** (`JIRA_TOOL_ALLOW_WRITE=1`): `create_issue`, `update_issue`, `assign_issue`, `transition_issue`,
  `add_comment`. Without it tool calls are refused with `permission_denied`; workflow nodes are unaffected.
- **Node only:** `delete_issue`.
- `api_request` is GET-only for agents.
- Blank `text`/`description_text` and an `update_issue` without any field to change are refused with `invalid_input`.
- Creates, transitions and comments are never retried after an unknown outcome; the error says how to check.

## Errors
The first of `errorMessages` (or a field error such as `errors.summary`) is shown. 401 is `auth_error` (wrong email
or token), 403 `permission_denied`, 404 `not_found` (also for issues the user cannot browse), 400 `invalid_input`
(bad JQL, missing fields), 429 `rate_limited`.

## Testing
```bash
npm test          # from the repo root
```
Contract suite for every operation, plus site URL validation, Basic auth, `nextPageToken` paging, error mapping and
the ADF conversion. Live check: the example with invalid credentials gives
`auth_error: API error 401: Client must be authenticated to access this resource.`

## License
Apache-2.0
