# sentry

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Sentry web API](https://docs.sentry.io/api/)
on sentry.io. It lists organizations, projects, releases, issues and events (with stack traces), and resolves,
archives (ignores), assigns or deletes issues. It is built with the declarative REST layer
([`definition.mjs`](definition.mjs)) plus a small pagination fix ([`lib/empty-page.mjs`](lib/empty-page.mjs)).

## Features
- **Organizations and projects:** `list_organizations`, `list_projects`, `list_releases`
- **Issues:** `list_issues` (Sentry search syntax, default `is:unresolved`), `get_issue`
- **Events:** `list_issue_events`, `get_issue_event` (`latest`, `oldest`, `recommended` or an id),
  `list_project_events`, `get_project_event`
- **Triage:** `resolve_issue` (now, next release or a release), `ignore_issue` (archive forever, until escalating,
  for N minutes or until N events), `update_issue` (status, assignee, priority, bookmark, seen), `delete_issue`
  (node only)
- **`api_request`:** any other endpoint under `/api/0` (GET only for agents), e.g. `/organizations/acme/stats_v2/`

Lists follow Sentry's `Link` header: pass `next_cursor` back as `cursor`. Sentry always advertises a next page; the
plugin ends the listing at the first empty page (at most one extra call). Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A sentry.io organization. Self-hosted Sentry is not supported yet.

## Installation
```bash
graphrt plugin install ./sentry
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `SENTRY_AUTH_TOKEN` | yes | User auth token, internal integration token, or organization token (`Authorization: Bearer`) |
| `SENTRY_REGION` | no | `us` (default) or `de`: your organization's data storage location |
| `SENTRY_TOOL_ALLOW_WRITE` | no | `1` lets agent tools resolve, ignore and update issues |

**Getting a token:** Sentry → Settings → Account → Personal Tokens (user auth token), or Settings → Developer Settings
→ Custom Integrations (internal integration, recommended for automations). Scopes: `org:read`, `project:read`,
`event:read` for reads, `event:write` for resolve/ignore/update, `event:admin` for `delete_issue`. Organization tokens
(`sntrys_...`) are meant for releases and source maps and cannot read issues.

**Rate limits:** Sentry limits each endpoint per caller (headers `X-Sentry-Rate-Limit-*`); 429 is `rate_limited`.

## Quick Start
```bash
SENTRY_AUTH_TOKEN=... graphrt run sentry/example.yaml --plugins .
```
The example lists your organizations and the five most frequent unresolved issues of the last 24 hours.

## Usage
```yaml
- id: latest
  type: sentry.get_issue_event
  organization: acme
  issue_id: "{{#start.issue_id#}}"
  event_id: latest
- id: resolve
  type: sentry.resolve_issue
  organization: acme
  issue_id: "{{#start.issue_id#}}"
  in_next_release: true
```

## Agent policy
- **Reads** are agent tools (events can contain user data: request bodies, IPs, user ids; Sentry scrubs what your
  data-scrubbing settings cover).
- **Opt-in writes** (`SENTRY_TOOL_ALLOW_WRITE=1`): `update_issue`, `resolve_issue`, `ignore_issue`.
- **Node only:** `delete_issue`.
- `api_request` is GET-only for agents and refuses service-hook paths (`.../hooks/`, they return the hook's signing
  secret), after decoding and resolving `.`/`..`.

## Errors
Sentry's `{"detail": ...}` is shown. 401 is `auth_error`, 403 `permission_denied` (missing scope), 404 `not_found`
(also for the wrong region: set `SENTRY_REGION`), 400 `invalid_input`, 429 `rate_limited`.

## Testing
```bash
npm test          # from the repo root
```
Contract suite for every operation, plus region selection, error mapping, opt-in policy and the empty-page fix.
Live check: the example with an invalid token gives `auth_error: API error 401: Invalid org token`.

## License
Apache-2.0
