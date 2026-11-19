# jira operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `jira.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_myself` | The Atlassian account the credentials belong to; a cheap way to check them |  |
| `search_issues` | Search issues with JQL, e.g. "project = OPS AND statusCategory != Done ORDER BY updated DESC" (bounded queries only; no total count) | **jql**, fields, expand, cursor, limit |
| `get_issue` | One issue with all fields (description and comments are ADF) | **issue_key**, fields, expand |
| `create_issue` | Create an issue in a project (as an agent tool only when JIRA_TOOL_ALLOW_WRITE=1) | **project_key**, **issue_type**, **summary**, description, labels, priority, assignee_account_id, due_date, parent_key, description_text |
| `update_issue` | Change an issue's summary, description, labels, priority, assignee or due date (given fields only) (as an agent tool only when JIRA_TOOL_ALLOW_WRITE=1) | **issue_key**, summary, description, labels, priority, assignee_account_id, due_date, notify_users, description_text |
| `delete_issue` | Delete an issue permanently | **issue_key**, delete_subtasks |
| `assign_issue` | Assign an issue to a user by accountId (as an agent tool only when JIRA_TOOL_ALLOW_WRITE=1) | **issue_key**, **account_id** |
| `list_transitions` | Workflow transitions available for an issue now (id and target status), for transition_issue | **issue_key** |
| `transition_issue` | Move an issue through its workflow with a transition id from list_transitions (as an agent tool only when JIRA_TOOL_ALLOW_WRITE=1) | **issue_key**, **transition_id**, resolution |
| `list_comments` | Comments on an issue (bodies are ADF) | **issue_key**, order_by, cursor, limit |
| `add_comment` | Add a comment to an issue (plain `text` or an ADF `body`) (as an agent tool only when JIRA_TOOL_ALLOW_WRITE=1) | **issue_key**, body, text |
| `list_projects` | Projects visible to the user | query, order_by, cursor, limit |
| `get_project` | One project with its issue types, lead and components | **project_key** |
| `list_issue_types` | Issue types you can create in a project (names for create_issue) | **project_key**, cursor, limit |
| `find_assignable_users` | Users who can be assigned in a project or issue (accountId for assignments) | query, project, issue_key, cursor, limit |
| `api_request` | Call any Jira Cloud REST API v3 endpoint that has no dedicated operation, e.g. path "/issue/OPS-1/changelog". Only the API's own host is allowed. | method, **path**, query, body |
