# asana operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `asana.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_me` | The user who owns the token, with their workspaces | opt_fields |
| `list_workspaces` | Workspaces and organizations the user belongs to | cursor, limit |
| `list_users` | Users of a workspace (gids for assignees) | **workspace_gid**, opt_fields, cursor, limit |
| `list_projects` | Projects of a workspace or team | workspace_gid, team_gid, archived, opt_fields, cursor, limit |
| `get_project` | One project | **project_gid**, opt_fields |
| `list_sections` | Sections (columns) of a project | **project_gid**, cursor, limit |
| `list_tasks` | Tasks of a project, a section, or an assignee in a workspace (give exactly one of project_gid, section_gid, or assignee with workspace_gid) | project_gid, section_gid, assignee, workspace_gid, completed_since, modified_since, opt_fields, cursor, limit |
| `get_task` | One task with its details | **task_gid**, opt_fields |
| `search_tasks` | Full-text task search in a workspace (premium workspaces only; 402 otherwise). No paging: sort by created_at and filter to page manually | **workspace_gid**, text, completed, assignee_any, projects_any, is_subtask, modified_after, due_on_before, sort_by, sort_ascending, max_results, opt_fields |
| `list_subtasks` | Subtasks of a task | **task_gid**, opt_fields, cursor, limit |
| `list_stories` | Stories of a task: comments (resource_subtype comment_added) and system events | **task_gid**, opt_fields, cursor, limit |
| `create_task` | Create a task in a workspace and/or projects | **name**, notes, html_notes, assignee, due_on, due_at, start_on, workspace_gid, project_gids, opt_fields |
| `update_task` | Change a task's name, description, assignee, dates or completion | **task_gid**, name, notes, html_notes, assignee, due_on, due_at, start_on, completed |
| `complete_task` | Mark a task complete (or incomplete again with completed: false) | **task_gid**, completed |
| `create_subtask` | Create a subtask under a task | **task_gid**, **name**, notes, html_notes, assignee, due_on, due_at, start_on |
| `create_section` | Add a section to a project | **project_gid**, **name** |
| `add_task_to_section` | Move a task into a section of a project it belongs to (moving again to the same place is harmless) | **section_gid**, **task_gid**, insert_before, insert_after |
| `add_comment` | Comment on a task (followers are notified) | **task_gid**, text, html_text, is_pinned |
| `delete_task` | Delete a task (it goes to the trash for 30 days) | **task_gid** |
| `api_request` | Call any Asana API endpoint that has no dedicated operation, e.g. path "/tags?workspace=<workspace gid>". Only the API's own host is allowed. Agent tools may only read tasks, projects, sections, users, workspaces, teams, tags, stories, portfolios, goals and similar resources (no webhooks, attachments, exports or audit logs). | method, **path**, query, body |
