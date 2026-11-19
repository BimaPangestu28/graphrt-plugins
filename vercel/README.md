# vercel

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Vercel REST API](https://vercel.com/docs/rest-api).
It lists and inspects deployments and their build logs, cancels or redeploys them, reads projects and domains, adds
project domains, and manages environment variables from workflow nodes. It is built with the declarative REST layer
([`definition.mjs`](definition.mjs)) plus two small wrappers ([`lib/vercel-wrappers.mjs`](lib/vercel-wrappers.mjs)).

## Features
- **Account and projects:** `get_user`, `list_teams`, `list_projects`, `get_project`
- **Deployments:** `list_deployments`, `get_deployment`, `list_deployment_events` (build logs), `cancel_deployment`,
  `redeploy` (node only), `delete_deployment` (node only)
- **Environment variables (node only):** `list_env_vars`, `get_env_var`, `create_env_var`, `update_env_var`,
  `delete_env_var`
- **Domains:** `list_domains`, `get_domain`, `get_domain_config` (misconfiguration check), `list_project_domains`,
  `add_project_domain`
- **`api_request`:** any other endpoint on `api.vercel.com` (agents: GET only, on an allowlist of non-secret paths)

Lists page with Vercel's `pagination.next` (passed back as `until`, or `from` for projects): pass `next_cursor` back
as `cursor`; `limit` max 100. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- Network access to `api.vercel.com`

## Installation
```bash
graphrt plugin install ./vercel
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `VERCEL_TOKEN` | yes | Access token (`Authorization: Bearer`) |
| `VERCEL_TEAM_ID` | no | Default team (`team_...`) sent as `teamId` when a call has no `team_id` (also for `api_request`, unless its query names `teamId` or `slug`) |
| `VERCEL_TOOL_ALLOW_WRITE` | no | `1` lets agent tools cancel deployments and add project domains |
| `VERCEL_TOOL_API_EXTRA_PATHS` | no | More read paths for agent `api_request`, comma-separated, `*` = one segment |

**Getting a token:** Vercel → Account Settings → Tokens → Create. Choose the scope (personal account or one team)
and an expiry. Tokens have the full rights of your role in that scope, so prefer a team-scoped token with a short
expiry for automations.

**Rate limits:** Vercel limits per endpoint (e.g. deployments list, project and domain calls); 429 is `rate_limited`
and honours `Retry-After`.

## Quick Start
```bash
VERCEL_TOKEN=... graphrt run vercel/example.yaml --plugins .
```
The example prints your username and your five latest deployments.

## Usage
```yaml
- id: failed
  type: vercel.list_deployments
  project_id: web
  state: ERROR
  limit: 1
- id: logs
  type: vercel.list_deployment_events
  id_or_url: "{{#failed.data.0.uid#}}"
  direction: backward
  max_events: 100
```

## Agent policy
- **Reads** of deployments, projects and domains are agent tools. For tools, `get_project` and `list_projects` drop
  the secret-bearing fields of project objects (`env` with its values, `legacyValue`, `vsmValue`, `encryptedValue`,
  `protectionBypass` secrets, `deployHooks` URLs, `passwordProtection`, `requestLogsKey`); workflow nodes get them in
  full.
- **Build logs can contain secrets:** `list_deployment_events` returns what the build printed. A build script that
  echoes an environment variable puts its value in the log, and agents can read it.
- **Opt-in writes** (`VERCEL_TOOL_ALLOW_WRITE=1`): `cancel_deployment`, `add_project_domain`.
- **Node only:** every environment-variable operation (values are secrets, even reads: plain values are returned in
  clear and `decrypt=true` decrypts the rest), `redeploy` (deploys code, possibly to production) and
  `delete_deployment`.
- **`api_request`** is GET-only for agents and reaches only an allowlist: the user, teams, deployments (with events,
  aliases and checks), domains and their config, project domains and aliases. The path is decoded and `.`/`..` and
  backslashes resolved before matching. Project objects (they embed env vars), env vars, secrets, tokens, deployment
  source files, log drains and integrations are refused. `VERCEL_TOOL_API_EXTRA_PATHS` adds paths (comma-separated,
  `*` = one segment) but never `env`, `tokens`, `secrets` or `files` paths.
- `redeploy` and `add_project_domain` are never retried after an unknown outcome; the error says how to check.

## Errors
Vercel's `error.message` is shown. A bad or expired token is answered with 403 plus `invalidToken: true`; the plugin
reports it as `auth_error: API error 403: Not authorized (invalid or expired token)`. Other 403s are
`permission_denied`, 404 `not_found`, 400 `invalid_input`, 429 `rate_limited`.

## Testing
```bash
npm test          # from the repo root
```
Contract suite for every operation, plus timestamp paging, the invalid-token mapping, the `VERCEL_TEAM_ID` default,
the `api_request` allowlist (with encoding and backslash bypasses) and the stripping of project secrets. Live check:
the example with an invalid token gives `auth_error: API error 403: Not authorized (invalid or expired token)`.

## License
Apache-2.0
