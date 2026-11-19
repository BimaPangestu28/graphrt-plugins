# vercel operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `vercel.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_user` | The user the token belongs to; a cheap way to check the token |  |
| `list_teams` | Teams the user belongs to (ids for team_id) | cursor, limit |
| `list_projects` | Projects, most recently updated first | team_id, search, repo, cursor, limit |
| `get_project` | One project: framework, settings, linked repository, latest deployments | team_id, **id_or_name** |
| `list_deployments` | Deployments, newest first, optionally for one project, environment, state or branch | team_id, project_id, target, state, branch, sha, cursor, limit |
| `get_deployment` | One deployment: state, URL, aliases, git metadata, errors | team_id, **id_or_url** |
| `list_deployment_events` | Build events (log lines) of a deployment, for debugging failed builds | team_id, **id_or_url**, direction, max_events |
| `cancel_deployment` | Cancel a deployment that is still building (as an agent tool only when VERCEL_TOOL_ALLOW_WRITE=1) | team_id, **deployment_id** |
| `redeploy` | Create a new deployment from an existing one (same source and settings), optionally to production | team_id, **name**, **deployment_id**, target |
| `delete_deployment` | Delete a deployment | team_id, **deployment_id** |
| `list_env_vars` | Environment variables of a project (plain values in clear; decrypt=true decrypts encrypted ones) | team_id, **id_or_name**, decrypt, git_branch |
| `get_env_var` | One environment variable with its decrypted value | team_id, **id_or_name**, **env_id** |
| `create_env_var` | Add an environment variable to a project (upsert=true replaces an existing key) | team_id, **id_or_name**, upsert, **key**, **value**, env_type, **target**, git_branch, comment |
| `update_env_var` | Change an environment variable's value, targets or branch | team_id, **id_or_name**, **env_id**, value, env_type, target, git_branch, comment |
| `delete_env_var` | Remove an environment variable from a project | team_id, **id_or_name**, **env_id** |
| `list_domains` | Domains registered or added to the account | team_id, cursor, limit |
| `get_domain` | One domain: verification, nameservers, registrar, expiry | team_id, **domain** |
| `get_domain_config` | Whether a domain is configured correctly (misconfigured flag, recommended A/CNAME records) | team_id, **domain**, project_id_or_name |
| `list_project_domains` | Domains of a project, with redirects and verification state | team_id, **id_or_name**, production, verified, cursor, limit |
| `add_project_domain` | Add a domain to a project (DNS must point to Vercel; verification may be needed) (as an agent tool only when VERCEL_TOOL_ALLOW_WRITE=1) | team_id, **id_or_name**, **name**, git_branch, redirect, redirect_status_code |
| `api_request` | Call any Vercel REST API endpoint that has no dedicated operation, e.g. path "/v4/aliases". Only the API's own host is allowed. | method, **path**, query, body |
