# todoist operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `todoist.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_user` | The account's name, email, time zone, inbox project and goals (token fields removed) |  |
| `list_projects` | Active projects | folder_id, cursor, limit |
| `get_project` | One project | **project_id** |
| `create_project` | Create a personal project (or a sub-project with parent_id) | **name**, parent_id, description, color, is_favorite, project_view_style |
| `update_project` | Rename a project or change its description, color, favorite flag or layout | **project_id**, name, description, color, is_favorite, project_view_style |
| `list_sections` | Sections of a project (or of all projects) | project_id, cursor, limit |
| `create_section` | Add a section to a project | **name**, **project_id**, order |
| `list_tasks` | Active tasks, optionally of one project, section, parent task or label | project_id, section_id, parent_id, label, ids, cursor, limit |
| `filter_tasks` | Active tasks matching a Todoist filter query, e.g. "today \| overdue", "#Work & p1", "assigned to: me" | **query**, lang, cursor, limit |
| `list_completed_tasks` | Tasks completed in a time range (up to 3 months), optionally in one project or section | **since**, **until**, project_id, section_id, filter_query, cursor, limit |
| `get_task` | One task | **task_id** |
| `create_task` | Create a task (in the Inbox unless a project is given) | **content**, project_id, section_id, parent_id, order, description, labels, priority, due_string, due_date, due_datetime, due_lang, assignee_id, duration, duration_unit, deadline_date |
| `quick_add_task` | Create a task from one line in the apps' Quick Add syntax, e.g. "Pay rent tomorrow #Home @bills p1" | **text**, note, reminder, auto_reminder |
| `update_task` | Change a task's content, description, labels, priority, due date, deadline, duration or assignee | **task_id**, content, description, labels, priority, due_string, due_date, due_datetime, due_lang, assignee_id, duration, duration_unit, deadline_date |
| `move_task` | Move a task to another project, section or parent task (give exactly one) | **task_id**, project_id, section_id, parent_id |
| `close_task` | Complete a task (a recurring task moves to its next date) | **task_id** |
| `reopen_task` | Mark a completed task as not completed | **task_id** |
| `delete_task` | Delete a task and its sub-tasks | **task_id** |
| `list_labels` | Personal labels | cursor, limit |
| `list_comments` | Comments of a task or of a project (give exactly one of task_id, project_id) | task_id, project_id, cursor, limit |
| `add_comment` | Comment on a task or a project (give exactly one of task_id, project_id); uids_to_notify notifies project collaborators | **content**, task_id, project_id, uids_to_notify |
| `api_request` | Call any Todoist API v1 endpoint that has no dedicated operation, e.g. path "/projects/{project_id}/collaborators". Only the API's own host is allowed. Agent tools may only read /projects, /sections, /tasks, /labels, /comments and /folders paths. | method, **path**, query, body |
