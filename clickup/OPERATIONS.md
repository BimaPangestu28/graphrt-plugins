# clickup operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `clickup.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_user` | The user the token belongs to |  |
| `list_teams` | Workspaces (teams) the token can access, with members |  |
| `list_spaces` | Spaces of a workspace | **team_id**, archived |
| `get_space` | One space with its statuses and features | **space_id** |
| `list_folders` | Folders of a space, with their lists | **space_id**, archived |
| `list_lists` | Lists in a folder | **folder_id**, archived |
| `list_folderless_lists` | Lists directly in a space (not in a folder) | **space_id**, archived |
| `get_list` | One list with its statuses | **list_id** |
| `list_tasks` | Tasks of a list (100 per page; closed tasks and subtasks only when asked) | **list_id**, archived, order_by, reverse, subtasks, include_closed, statuses, assignees, tags, due_date_gt, due_date_lt, date_updated_gt, include_markdown_description, cursor |
| `search_tasks` | Tasks across a workspace filtered by space, folder, list, status, assignee, tag or dates (100 per page) | **team_id**, space_ids, folder_ids, list_ids, parent_task_id, order_by, reverse, subtasks, include_closed, statuses, assignees, tags, due_date_gt, due_date_lt, date_updated_gt, include_markdown_description, cursor |
| `get_task` | One task with assignees, status, dates, custom fields and checklists | **task_id**, custom_task_ids, team_id, include_subtasks, include_markdown_description |
| `get_time_in_status` | How long a task has spent in each status | **task_id**, custom_task_ids, team_id |
| `create_task` | Create a task (or a subtask with parent_task_id) in a list; assignees and watchers are notified by ClickUp | **list_id**, **name**, description, markdown_content, status, priority, due_date, due_date_time, start_date, start_date_time, time_estimate, points, assignees, tags, parent_task_id, links_to, notify_all, custom_fields |
| `update_task` | Change a task's name, description, status, priority, dates, estimate, assignees or archived flag | **task_id**, custom_task_ids, team_id, name, description, markdown_content, status, priority, due_date, due_date_time, start_date, start_date_time, time_estimate, points, archived, add_assignees, remove_assignees |
| `delete_task` | Delete a task | **task_id**, custom_task_ids, team_id |
| `list_comments` | The 25 newest comments of a task; for older ones pass start and start_id of the last comment | **task_id**, custom_task_ids, team_id, start, start_id |
| `add_comment` | Add a comment to a task (assignees and watchers are notified by ClickUp) | **task_id**, custom_task_ids, team_id, **comment_text**, assignee, notify_all |
| `list_time_entries` | Time entries of a workspace in a date range (default: your entries of the last 30 days; a negative duration is a running timer) | **team_id**, start_date, end_date, assignee, space_id, folder_id, list_id, task_id, is_billable, include_task_tags, include_location_names |
| `api_request` | Call any ClickUp API v2 endpoint that has no dedicated operation, e.g. path "/list/{list_id}/member". Only the API's own host is allowed. Agent tools may only read the user, workspaces, spaces, folders, lists, views, tasks, comments and time entries. | method, **path**, query, body |
