# github

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [GitHub REST API](https://docs.github.com/en/rest)
(API version `2026-03-10`). It reads repositories, issues, pull requests, file contents, search results, releases,
Actions runs and notifications, and writes issues, comments and pull requests. It is built with the declarative
REST layer: the whole plugin is the data in [`definition.mjs`](definition.mjs).

## Features
- **Repositories:** `get_authenticated_user`, `list_my_repos`, `list_org_repos`, `get_repo`, `get_contents`
  (file or directory at any path, e.g. `src/lib/main.js`), `create_or_update_file` (node only)
- **Issues:** `list_issues`, `get_issue`, `create_issue`, `update_issue`, `list_issue_comments`, `create_issue_comment`
- **Pull requests:** `list_pulls`, `get_pull`, `list_pull_files`, `create_pull`, `list_pull_review_comments`,
  `create_pull_review_comment`, `merge_pull` (node only)
- **Search:** `search_code`, `search_issues` (issues and pull requests, optional advanced syntax)
- **Releases:** `list_releases`, `get_latest_release`, `get_release`, `create_release` and `delete_release` (node only)
- **Actions:** `list_workflow_runs`, `get_workflow_run`, `rerun_workflow_run`, `rerun_failed_jobs`
- **Notifications:** `list_notifications`, `mark_notification_read`
- **`api_request`:** any other endpoint on `api.github.com` (GET only for agents)

All lists use GitHub's `Link` header: pass `next_cursor` back as `cursor` for the next page, `limit` sets `per_page`
(max 100). Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- Network access to `api.github.com`

## Installation
```bash
graphrt plugin install ./github
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | yes | Fine-grained or classic personal access token, or a GitHub App installation token |
| `GITHUB_TOOL_ALLOW_WRITE` | no | `1` lets agent tools create/update issues, comment, open pull requests and mark notifications read |
| `GITHUB_TOOL_ALLOW_CI` | no | `1` lets agent tools re-run workflow runs |
| `GITHUB_TOOL_ALLOWED_REPOS` | for tool writes | Comma-separated `owner/name` repositories agent tools may write to (`*` = any) |

**Getting a token:** GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens. Choose
the repositories and grant only what you use:
- Contents: read (contents, releases); Contents: write only for `create_or_update_file` and `create_release`
- Issues: read/write; Pull requests: read/write (`merge_pull` also needs Contents: write)
- Actions: read/write (`rerun_*` needs write); Metadata: read (always)
- Notifications are only available to classic tokens with the `notifications` scope.

A node may pass `access_token` to use another token for that call.

**Rate limits:** 5,000 requests an hour per user token (15,000 for Enterprise Cloud apps), code search 10 requests a
minute. GitHub reports an exhausted limit as 403 or 429 (with `x-ratelimit-remaining: 0`, a `retry-after` header or a
"rate limit" message); the plugin reports all of these as `rate_limited` with the wait from `retry-after` or
`x-ratelimit-reset`, and retries by itself only when the wait is under a minute.

## Quick Start
```bash
GITHUB_TOKEN=... graphrt run github/example.yaml --plugins .
```
The example reads `octocat/Hello-World` and its latest open issues.

## Usage
```yaml
- id: failing
  type: github.list_workflow_runs
  owner: acme
  repo: api
  branch: main
  status: failure
  limit: 5
- id: file
  type: github.get_contents
  owner: acme
  repo: api
  file_path: config/app.yaml
  ref: main
```
- `get_contents` returns GitHub's object; a file's text is base64 in `data.content`.
- `list_issues` also returns pull requests (they have a `pull_request` key); use `list_pulls` for PRs only.
- Labels and assignees given to `update_issue` replace the current ones.

## Agent policy
- **Reads** are agent tools.
- **Opt-in writes** (`GITHUB_TOOL_ALLOW_WRITE=1`): `create_issue`, `update_issue`, `create_issue_comment`, `create_pull`,
  `create_pull_review_comment`, `mark_notification_read`.
- **Opt-in CI** (`GITHUB_TOOL_ALLOW_CI=1`, separate from writes): `rerun_workflow_run`, `rerun_failed_jobs`. Agents
  can never set `enable_debug_logging` (debug logs can print secrets); workflow nodes can.
- **Repository allowlist:** every opt-in tool write on a repository (all of the above except `mark_notification_read`)
  must also target a repository listed in `GITHUB_TOOL_ALLOWED_REPOS` (`owner/name`, case-insensitive; `*` = any).
  This limits exfiltration: an agent that can read a private repository could otherwise paste its code into an issue
  or comment on a public repository the same token can write to. Prefer a fine-grained token limited to the same
  repositories.
- Without the opt-in, tool calls are refused with `permission_denied`; workflow nodes are unaffected by all of this.
- **Node only** (never offered to an LLM): `merge_pull`, `create_or_update_file` (pushes a commit), `create_release`
  (creates tags, may trigger deployments), `delete_release`.
- `api_request` is GET-only for agents and refuses paths with a `variables` or `hooks` segment (Actions, environment
  and organization variables; webhook configurations), after decoding and resolving `.`/`..`.
- Creates and comments are never retried after an unknown outcome; the error says how to check.

## Per-user tokens (multi-user agents)

Set `GITHUB_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin github`):

```yaml
tools: [github/get_authenticated_user]
tool_context:
  github:
    access_token: "{{#start.github_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is a GitHub OAuth app / GitHub App user access token (or a fine-grained PAT) of that user.
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `GITHUB_TOKEN` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
GitHub's `{"message": ...}` is shown in the error. 401 is `auth_error`, 403 `permission_denied`, a rate limit
`rate_limited` (see above), 404 `not_found` (also for private repositories the token cannot see), 422
`invalid_input`.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite (every operation's exact request) plus GitHub-specific
cases: API version header, Link pagination, node-only and opt-in policy, the repository allowlist, the CI opt-in and
debug-logging refusal, the `api_request` path guard and rate-limit detection. Live check: the example with an invalid token
gives `auth_error: API error 401: Bad credentials`.

## License
Apache-2.0
