# gitlab

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [GitLab REST API v4](https://docs.gitlab.com/api/rest/)
on gitlab.com or a self-hosted GitLab. It reads projects, issues, merge requests, pipelines and repository files, and
writes issues, comments and merge requests. It is built with the declarative REST layer
([`definition.mjs`](definition.mjs)) plus agent-tool policies: an `api_request` path allowlist ([`lib/tool-path-policy.mjs`](lib/tool-path-policy.mjs)) and a
project allowlist for tool writes ([`lib/tool-call-policy.mjs`](lib/tool-call-policy.mjs)).

## Features
- **User and projects:** `get_current_user`, `list_projects`, `get_project`
- **Issues:** `list_issues`, `get_issue`, `create_issue`, `update_issue` (incl. close/reopen), `delete_issue` (node only),
  `list_issue_notes`, `create_issue_note`
- **Merge requests:** `list_merge_requests`, `get_merge_request`, `list_merge_request_diffs`, `create_merge_request`,
  `list_merge_request_notes`, `create_merge_request_note`, `merge_merge_request` (node only)
- **Pipelines:** `list_pipelines`, `get_pipeline`, `list_pipeline_jobs`, `retry_pipeline`, `cancel_pipeline`,
  `create_pipeline` (node only)
- **Repository files:** `get_file`, `list_repository_tree`, `create_file` and `update_file` (node only)
- **`api_request`:** any other v4 endpoint (agents: GET only, on an allowlist of non-secret read paths)

`project_id` is the numeric id or the full path (`group/sub/project`; it is URL-encoded for you). Lists use GitLab's
`Link` header: pass `next_cursor` back as `cursor`; `limit` sets `per_page` (max 100). Full reference:
[OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- Network access to gitlab.com or your instance

## Installation
```bash
graphrt plugin install ./gitlab
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `GITLAB_TOKEN` | yes | Personal, project or group access token (sent as `Authorization: Bearer`), or an OAuth token |
| `GITLAB_BASE_URL` | no | Instance URL for self-hosted GitLab, e.g. `https://gitlab.example.com` (default `https://gitlab.com`) |
| `GITLAB_TOOL_ALLOW_WRITE` | no | `1` lets agent tools create/update issues and merge requests and comment |
| `GITLAB_TOOL_ALLOW_CI` | no | `1` lets agent tools retry and cancel pipelines |
| `GITLAB_TOOL_ALLOWED_PROJECTS` | for tool writes | Comma-separated projects agent tools may write to (`group/app`, `42`; `*` = any) |
| `GITLAB_TOOL_API_EXTRA_PATHS` | no | More read paths for agent `api_request`, e.g. `/projects/*/environments` |

`GITLAB_BASE_URL` must be https (http only for localhost), without credentials, query or fragment; a path prefix
(`https://example.com/gitlab`) is kept and a trailing `/api/v4` is accepted. Invalid values fail the call with
`invalid_input`. The token is only ever sent to that origin.

**Getting a token:** GitLab → avatar → Edit profile → Access tokens. Scopes: `read_api` for reads, `api` for writes.
Project/group access tokens work the same way and can be limited to one project. A node may pass `access_token` to
use another token for that call.

**Rate limits:** gitlab.com allows about 2,000 authenticated API requests a minute per user; self-hosted limits are set
by the admin. 429 is `rate_limited` and honours `Retry-After`.

## Quick Start
```bash
GITLAB_TOKEN=... graphrt run gitlab/example.yaml --plugins .
```
The example reads the token's user and the latest pipelines of the public `gitlab-org/gitlab-runner` project.

## Usage
```yaml
- id: failed
  type: gitlab.list_pipelines
  project_id: acme/api
  ref: main
  status: failed
  limit: 1
- id: jobs
  type: gitlab.list_pipeline_jobs
  project_id: acme/api
  pipeline_id: "{{#failed.data.0.id#}}"
  scope: [failed]
```
- `get_file` needs `ref`; the content is base64 in `data.content`.
- `labels` in writes is a comma-separated string; `update_issue` also takes `add_labels`/`remove_labels`.

## Agent policy
- **Reads** are agent tools.
- **Opt-in writes** (`GITLAB_TOOL_ALLOW_WRITE=1`): `create_issue`, `update_issue`, `create_issue_note`,
  `create_merge_request`, `create_merge_request_note`.
- **Opt-in CI** (`GITLAB_TOOL_ALLOW_CI=1`, separate from writes): `retry_pipeline`, `cancel_pipeline`.
- **Project allowlist:** every opt-in tool write (including CI) must also target a project listed in
  `GITLAB_TOOL_ALLOWED_PROJECTS`, written exactly as the call passes `project_id` (full path or numeric id; `*` = any).
  This limits exfiltration: an agent that reads a private project could otherwise paste its code into an issue or
  comment on a public project the same token can write to.
- **Node only:** `merge_merge_request`, `create_file`, `update_file` (push commits), `create_pipeline` (may deploy),
  `delete_issue`.
- **`api_request`** is GET-only for agents and reaches only an allowlist of read-only paths: user, version, projects,
  issues and merge requests (with notes, discussions, diffs), milestones, labels, releases, members, pipelines and
  their jobs and test reports, job metadata, repository tree/files/commits/branches/tags/compare, groups and search.
  Before matching, the path is decoded, `.`/`..` and backslashes are resolved and a format suffix (`.json`) is
  stripped. Everything else is refused for tools, in particular CI/CD variables, triggers, pipeline schedules (they
  return variable values), secure files, Terraform state, deploy and access tokens, hooks, runners, packages, and job
  traces and artifacts (jobs can print unmasked variables). `GITLAB_TOOL_API_EXTRA_PATHS` adds paths
  (comma-separated, `*` = one segment, e.g. `/projects/*/environments`), but never the refused ones above.
  Workflow nodes can call any path.
- Creates and comments are never retried after an unknown outcome; the error says how to check.

## Errors
GitLab's `message` (or `error`/`error_description`) is shown. 401 is `auth_error`, 403 `permission_denied`, 404
`not_found` (also for projects the token cannot see), 400/422 `invalid_input`, 429 `rate_limited`.

## Testing
```bash
npm test          # from the repo root
```
Contract suite for every operation, plus tests for `GITLAB_BASE_URL` validation, the `api_request` allowlist (with the
encoding, dot-segment and `.json` bypasses), the project allowlist and the CI opt-in. Live
check: the example with an invalid token gives `auth_error: API error 401: 401 Unauthorized`.

## License
Apache-2.0
