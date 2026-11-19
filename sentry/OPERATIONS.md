# sentry operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `sentry.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_organizations` | Organizations the token can access (slug for other calls) | owner, query, cursor, limit |
| `list_projects` | Projects of an organization | **organization**, query, cursor, limit |
| `list_releases` | Releases of an organization, newest first | **organization**, project, environment, query, cursor, limit |
| `list_issues` | Issues of an organization; query uses Sentry search syntax, default "is:unresolved" | **organization**, query, project, environment, stats_period, sort, cursor, limit |
| `get_issue` | One issue: title, culprit, level, status, counts, first/last seen, assignee | **organization**, **issue_id** |
| `list_issue_events` | Events of an issue, newest first | **organization**, **issue_id**, full, query, environment, stats_period, cursor, limit |
| `get_issue_event` | One event of an issue with stack trace, breadcrumbs, tags and context (use latest for the newest) | **organization**, **issue_id**, **event_id**, environment |
| `list_project_events` | Recent error events of a project | **organization**, **project**, full, stats_period, cursor |
| `get_project_event` | One event by id within a project | **organization**, **project**, **event_id** |
| `update_issue` | Change an issue's status, assignee, priority, bookmark or seen flag (as an agent tool only when SENTRY_TOOL_ALLOW_WRITE=1) | **organization**, **issue_id**, status, assigned_to, priority, has_seen, is_bookmarked |
| `resolve_issue` | Mark an issue resolved now, in the next release, or in a given release (as an agent tool only when SENTRY_TOOL_ALLOW_WRITE=1) | **organization**, **issue_id**, in_next_release, in_release |
| `ignore_issue` | Archive an issue: forever, until it escalates, for some minutes, or until it reaches a count (as an agent tool only when SENTRY_TOOL_ALLOW_WRITE=1) | **organization**, **issue_id**, substatus, ignore_duration, ignore_count, ignore_window, ignore_user_count, ignore_user_window |
| `delete_issue` | Delete an issue and its events | **organization**, **issue_id** |
| `api_request` | Call any Sentry API endpoint that has no dedicated operation, e.g. path "/organizations/acme/stats_v2/". Only the API's own host is allowed. | method, **path**, query, body |
