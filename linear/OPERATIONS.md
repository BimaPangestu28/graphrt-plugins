# linear operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `linear.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_viewer` | The user the API key belongs to and their workspace; a cheap way to check the key |  |
| `list_teams` | Teams in the workspace (id and key for issues) | include_archived, cursor, limit |
| `get_team` | One team with its workflow states (state ids for issues) and members | **team_id** |
| `list_workflow_states` | Workflow states (Backlog, Todo, In Progress, Done...) of all teams, or filtered | filter, cursor, limit |
| `list_users` | Users of the workspace (ids for assignees) | filter, cursor, limit |
| `list_issues` | Issues, optionally filtered with an IssueFilter, e.g. {"team": {"key": {"eq": "ENG"}}, "state": {"type": {"nin": ["completed", "canceled"]}}} | filter, include_archived, order_by, cursor, limit |
| `search_issues` | Full-text search of issues by title and description (optionally comments) | **term**, team_id, include_comments, cursor, limit |
| `get_issue` | One issue with description, parent, sub-issues and its latest 50 comments | **issue_id** |
| `create_issue` | Create an issue in a team (as an agent tool only when LINEAR_TOOL_ALLOW_WRITE=1) | **team_id**, **issue_title**, description, assignee_id, state_id, priority, project_id, label_ids, due_date, estimate, parent_id |
| `update_issue` | Change an issue's title, description, state, assignee, priority, project, labels, due date or estimate (as an agent tool only when LINEAR_TOOL_ALLOW_WRITE=1) | **issue_id**, issue_title, description, assignee_id, state_id, priority, project_id, label_ids, due_date, estimate, parent_id |
| `delete_issue` | Move an issue to the trash (restorable for a while in Linear, then deleted) | **issue_id** |
| `list_comments` | Comments on an issue, oldest first | **issue_id**, cursor, limit |
| `create_comment` | Add a Markdown comment to an issue (as an agent tool only when LINEAR_TOOL_ALLOW_WRITE=1) | **issue_id**, **body** |
| `list_projects` | Projects with status, progress, dates, lead and teams | filter, include_archived, order_by, cursor, limit |
| `get_project` | One project with its first 100 issues | **project_id** |
| `api_request` | Call any Linear GraphQL API endpoint that has no dedicated operation, e.g. path "/graphql". Only the API's own host is allowed. | method, **path**, query, body |
